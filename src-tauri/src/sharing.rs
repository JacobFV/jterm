//! What this computer makes available to other machines, as far as jterm can
//! honestly tell.
//!
//! jterm does not run a server of its own. Being reachable — from another
//! jterm over ssh, from a VNC viewer, from a Remote Desktop client — is the
//! operating system's own servers: Remote Login and Screen Sharing on a Mac,
//! Remote Desktop and OpenSSH Server on Windows, sshd and GNOME Remote Desktop
//! on Linux. Turning those on needs an administrator, which jterm is not and
//! should not ask to become, so this module does the two things it can do
//! well: say plainly what is on, and open the place where it is switched.
//!
//! "On" is decided by asking the port, not the settings: a connection to
//! `127.0.0.1` on the service's port either opens or it does not. That is the
//! one answer that is the same on every platform and cannot be stale — whatever
//! the settings say, a listening port is a server, and it is the server that a
//! visitor reaches. What it cannot see is a firewall between here and them,
//! which the page says.

use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Anything listening on loopback answers in microseconds; this only bounds a
/// machine so loaded it does not.
const PROBE_TIMEOUT: Duration = Duration::from_millis(300);

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Service {
    Ssh,
    Vnc,
    Rdp,
}

impl Service {
    fn port(self) -> u16 {
        match self {
            Service::Ssh => 22,
            Service::Vnc => 5900,
            Service::Rdp => 3389,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatus {
    service: Service,
    port: u16,
    listening: bool,
    /// Who may sign in, where the platform says. `None` is "every account on
    /// this computer" on a Mac, and "not known" elsewhere — the page words the
    /// two differently.
    allowed_users: Option<Vec<String>>,
    /// Groups on the allow-list, by name — `admin` is the usual one, which
    /// the page calls "administrators".
    allowed_groups: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharingStatus {
    /// What this machine is called on the local network, e.g. `studio.local`.
    host_name: Option<String>,
    user: Option<String>,
    /// Every address another machine could use to reach this one, loopback
    /// left out.
    addresses: Vec<String>,
    services: Vec<ServiceStatus>,
}

fn listening(port: u16) -> bool {
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    TcpStream::connect_timeout(&address, PROBE_TIMEOUT).is_ok()
}

fn addresses() -> Vec<String> {
    let mut found: Vec<String> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|interface| !interface.is_loopback())
        .map(|interface| interface.ip())
        // A link-local IPv6 address needs its interface named to be used at
        // all, and nobody types `fe80::…%en0` into a viewer.
        .filter(|ip| !matches!(ip, IpAddr::V6(v6) if (v6.segments()[0] & 0xffc0) == 0xfe80))
        .map(|ip| ip.to_string())
        .collect();
    found.sort();
    found.dedup();
    found
}

fn run(program: &str, args: &[&str]) -> Option<String> {
    let output = std::process::Command::new(program)
        .args(args)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(target_os = "macos")]
fn host_name() -> Option<String> {
    // The Bonjour name, which is what another Mac on the network can resolve.
    run("/usr/sbin/scutil", &["--get", "LocalHostName"]).map(|name| format!("{name}.local"))
}

#[cfg(not(target_os = "macos"))]
fn host_name() -> Option<String> {
    run("hostname", &[]).filter(|name| !name.is_empty())
}

/// Who a Mac lets use a service. macOS keeps an allow-list as a group —
/// `com.apple.access_ssh`, `com.apple.access_screensharing` — that exists only
/// while the setting says "Only these users"; with "All users" it is absent.
#[cfg(target_os = "macos")]
fn allowed(service: Service) -> (Option<Vec<String>>, Vec<String>) {
    let group = match service {
        Service::Ssh => "com.apple.access_ssh",
        Service::Vnc => "com.apple.access_screensharing",
        Service::Rdp => return (None, Vec::new()),
    };
    let Some(record) = run(
        "/usr/bin/dscl",
        &[
            ".",
            "-read",
            &format!("/Groups/{group}"),
            "GroupMembership",
            "NestedGroups",
        ],
    ) else {
        // No such group: every account may sign in.
        return (None, Vec::new());
    };
    let (users, nested) = parse_membership(&record);
    // Nested groups are listed by GUID, which means nothing to a person. Each
    // is looked up; one that cannot be is shown as "a group" rather than as
    // its GUID.
    let groups = nested
        .iter()
        .map(|guid| {
            run(
                "/usr/bin/dscl",
                &[".", "-search", "/Groups", "GeneratedUID", guid],
            )
            .and_then(|found| found.split_whitespace().next().map(str::to_string))
            .unwrap_or_else(|| "a group".to_string())
        })
        .collect();
    (users, groups)
}

#[cfg(not(target_os = "macos"))]
fn allowed(_service: Service) -> (Option<Vec<String>>, Vec<String>) {
    (None, Vec::new())
}

/// `dscl`'s answer, which is `Key: value value` lines, possibly wrapped: the
/// users by short name, and the nested groups by GUID.
#[cfg(any(target_os = "macos", test))]
fn parse_membership(record: &str) -> (Option<Vec<String>>, Vec<String>) {
    let mut users = Vec::new();
    let mut groups = Vec::new();
    let mut current = "";
    for line in record.lines() {
        let (key, rest) = match line.split_once(':') {
            Some((key, rest)) if !line.starts_with(' ') => (key.trim(), rest),
            _ => (current, line),
        };
        current = key;
        let words = rest.split_whitespace();
        match key {
            "GroupMembership" => users.extend(words.map(str::to_string)),
            "NestedGroups" => groups.extend(words.map(str::to_string)),
            _ => {}
        }
    }
    (Some(users), groups)
}

#[tauri::command]
pub async fn sharing_status() -> SharingStatus {
    tauri::async_runtime::spawn_blocking(|| {
        let services = [Service::Ssh, Service::Vnc, Service::Rdp]
            .into_iter()
            .map(|service| {
                let (allowed_users, allowed_groups) = allowed(service);
                ServiceStatus {
                    service,
                    port: service.port(),
                    listening: listening(service.port()),
                    allowed_users,
                    allowed_groups,
                }
            })
            .collect();
        SharingStatus {
            host_name: host_name(),
            user: std::env::var("USER")
                .or_else(|_| std::env::var("USERNAME"))
                .ok(),
            addresses: addresses(),
            services,
        }
    })
    .await
    .unwrap_or(SharingStatus {
        host_name: None,
        user: None,
        addresses: Vec::new(),
        services: Vec::new(),
    })
}

/// Open the system's own switch for a service. Returns whether anything was
/// opened, so the page can say where to look instead when nothing was.
#[tauri::command]
pub fn open_sharing_settings(service: Service) -> bool {
    open_settings(service)
}

#[cfg(target_os = "macos")]
fn open_settings(_service: Service) -> bool {
    // Remote Login and Screen Sharing are both under General → Sharing. The
    // address changed in Ventura; the old one still works on the old systems.
    for url in [
        "x-apple.systempreferences:com.apple.Sharing-Settings.extension",
        "x-apple.systempreferences:com.apple.preferences.sharing",
    ] {
        let opened = std::process::Command::new("/usr/bin/open")
            .arg(url)
            .status()
            .is_ok_and(|status| status.success());
        if opened {
            return true;
        }
    }
    false
}

#[cfg(windows)]
fn open_settings(service: Service) -> bool {
    let page = match service {
        Service::Rdp => "ms-settings:remotedesktop",
        // OpenSSH Server is an optional feature before it is a service.
        Service::Ssh => "ms-settings:optionalfeatures",
        Service::Vnc => return false,
    };
    std::process::Command::new("cmd")
        .args(["/C", "start", "", page])
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_settings(_service: Service) -> bool {
    // GNOME keeps sharing — Remote Desktop, Remote Login — under Sharing up to
    // 45 and under System from 46. Whichever this desktop has opens; one it
    // does not have exits at once with an error.
    for panel in ["sharing", "system"] {
        let opened = std::process::Command::new("gnome-control-center")
            .arg(panel)
            .spawn()
            .is_ok();
        if opened {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_an_allow_list_of_users() {
        let (users, groups) = parse_membership("GroupMembership: jacob guest\nNestedGroups:\n");
        assert_eq!(users, Some(vec!["jacob".to_string(), "guest".to_string()]));
        assert!(groups.is_empty());
    }

    #[test]
    fn notices_groups_on_the_allow_list() {
        let record =
            "GroupMembership: jacob\nNestedGroups:\n ABCDEFAB-CDEF-ABCD-EFAB-CDEF00000050\n";
        let (users, groups) = parse_membership(record);
        assert_eq!(users, Some(vec!["jacob".to_string()]));
        assert_eq!(
            groups,
            vec!["ABCDEFAB-CDEF-ABCD-EFAB-CDEF00000050".to_string()]
        );
    }

    #[test]
    fn reads_what_a_mac_set_to_administrators_says() {
        // Verbatim from macOS 26 with Remote Login set to "Only these users:
        // Administrators": no users at all, and the admin group nested.
        let (users, groups) =
            parse_membership("NestedGroups: ABCDEFAB-CDEF-ABCD-EFAB-CDEF00000050");
        assert_eq!(users, Some(vec![]));
        assert_eq!(groups.len(), 1);
    }

    #[test]
    fn a_port_with_a_listener_is_on_and_one_without_is_not() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(listening(port));
        drop(listener);
        assert!(!listening(port));
    }
}
