//! Bringing the window back when WebKit's web process dies underneath it.
//!
//! On Linux the whole of jterm's interface is a WebKitGTK webview, and that
//! webview's rendering happens in a *separate process* — the app is one
//! process, the thing that draws it is another. When the web process dies, the
//! app does not. It keeps its pty threads, keeps recording scrollback, keeps
//! every shell running; it simply has no surface left, and there is no longer
//! any DOM behind the close button to notice it being clicked. From the
//! outside this is indistinguishable from a hang, and the only way out is to
//! kill an app whose shells were all still working.
//!
//! WebKit will tell us this happened — `web-process-terminated` — and a
//! `reload` starts a fresh web process against the same window. That is the
//! whole recovery, and it is only survivable because of what is *not* in the
//! web process: the shells belong to `pty`, the scrollback to `store`, so the
//! reload has something to come back to. `pty_attach` is the other half of
//! this, and without it this file would be a way to lose every tab's work at
//! once rather than a way to recover it.
//!
//! **Reloading is budgeted.** A web process that dies on something in the page
//! itself will die again the moment the page comes back, and a handler that
//! answers every death with a reload turns that into a loop that pins a core
//! and never stops. After `BUDGET` deaths inside `WINDOW` this stops trying
//! and leaves the reason in the log, which is a frozen window — the thing we
//! started with — but with a record of why, and with the shells still running
//! for whatever attaches to them next.

/// How many reloads to spend before concluding the page is what is wrong.
const BUDGET: u32 = 3;
/// The span those reloads have to fall inside to count as a loop. A crash an
/// hour is a bug worth fixing; three in a minute is a page that cannot load.
const WINDOW: std::time::Duration = std::time::Duration::from_secs(60);

/// Spends reloads against a budget that refills once the crashes stop.
///
/// Split out from the signal handler because a GTK callback is not a thing a
/// test can call, while the part that can actually be wrong — the arithmetic
/// deciding when to give up — is all here.
#[derive(Default)]
pub struct Budget {
    spent: u32,
    since: Option<std::time::Instant>,
}

impl Budget {
    /// Record a crash at `now` and answer whether to reload for it.
    pub fn allows(&mut self, now: std::time::Instant) -> bool {
        // A quiet minute means whatever went wrong is not going wrong in a
        // loop, so the next crash is treated as the first one again.
        let lapsed = self
            .since
            .is_none_or(|since| now.duration_since(since) >= WINDOW);
        if lapsed {
            self.since = Some(now);
            self.spent = 0;
        }
        self.spent += 1;
        self.spent <= BUDGET
    }

    /// How many crashes have been seen in the current window.
    pub fn spent(&self) -> u32 {
        self.spent
    }
}

/// Watch `window`'s webview and reload it if its web process dies.
///
/// Off Linux this is nothing: the macOS and Windows webviews do not hand their
/// rendering to a child process that can die on its own, so there is no such
/// failure to recover from. Kept as an empty function rather than a `cfg` at
/// the call site so `lib.rs` reads the same on all three platforms.
#[cfg(not(target_os = "linux"))]
pub fn install(_window: &tauri::WebviewWindow) {}

#[cfg(target_os = "linux")]
pub fn install(window: &tauri::WebviewWindow) {
    use webkit2gtk::WebViewExt;

    let root = crate::data_dir();

    // `with_webview` hands the closure to the main thread, which is where GTK
    // requires the signal to be connected from — and where it will later be
    // delivered, so nothing inside the handler needs a lock.
    let _ = window.with_webview(move |platform| {
        // A GTK signal handler is `Fn`, so the budget it spends from cannot be
        // captured by value and mutated. `RefCell` rather than a lock because
        // this is only ever touched from the main thread, which is where the
        // handler was connected and where it will be delivered.
        let budget = std::cell::RefCell::new(Budget::default());

        platform
            .inner()
            .connect_web_process_terminated(move |view, reason| {
                let now = std::time::Instant::now();
                let mut budget = budget.borrow_mut();
                let allowed = budget.allows(now);
                crate::append_record(
                    &root,
                    &format!(
                        "webkit's web process died ({reason:?}); \
                     crash {} in the last {}s — {}",
                        budget.spent(),
                        WINDOW.as_secs(),
                        if allowed {
                            "reloading"
                        } else {
                            "not reloading again"
                        }
                    ),
                );
                if allowed {
                    // The shells are untouched by this; what comes back attaches
                    // to them again. See `pty::pty_attach`.
                    view.reload();
                }
            });
    });
}

#[cfg(test)]
mod tests {
    use super::{Budget, BUDGET, WINDOW};
    use std::time::Instant;

    /// The loop this exists to stop: crashes arriving faster than the page can
    /// load must run the budget out and then stay out.
    #[test]
    fn stops_reloading_a_page_that_keeps_dying() {
        let mut budget = Budget::default();
        let start = Instant::now();

        for nth in 1..=BUDGET {
            assert!(budget.allows(start), "reload {nth} is within budget");
        }
        assert!(
            !budget.allows(start),
            "the reload after the budget is refused"
        );
        assert!(!budget.allows(start), "and it stays refused");
    }

    /// A crash an hour is not a loop, and must not be treated as one — however
    /// many of them the process has seen.
    #[test]
    fn forgives_crashes_that_are_far_enough_apart() {
        let mut budget = Budget::default();
        let mut at = Instant::now();

        for nth in 0..BUDGET * 4 {
            assert!(budget.allows(at), "crash {nth} is on its own");
            assert_eq!(budget.spent(), 1, "each one starts a fresh window");
            at += WINDOW;
        }
    }

    /// The boundary between the two: a burst that exhausts the budget still
    /// recovers once the window has passed.
    #[test]
    fn refills_after_the_window_passes() {
        let mut budget = Budget::default();
        let start = Instant::now();

        for _ in 0..=BUDGET {
            budget.allows(start);
        }
        assert!(!budget.allows(start), "still inside the exhausted window");
        assert!(
            budget.allows(start + WINDOW),
            "a window later, reloading is worth trying again"
        );
    }
}
