/**
 * Another computer's screen, in a pane.
 *
 * The protocol is noVNC's, running here in the page; the connection is
 * `vnc.rs`, carried across by `lib/vncSocket.ts`. This file is the pane around
 * them: where to connect, what to say while it does, and what to say when it
 * does not.
 *
 * **The address form is the empty state.** A new VNC pane has nowhere to go
 * yet, so it opens on the form, and pressing the address in the toolbar later
 * goes back to it. A restored pane reconnects by itself — its address was
 * kept — and the server asks for its password again, because the password is
 * the one thing deliberately not kept. See `VncPaneState`.
 *
 * **Failure says why, in words.** "Disconnected" is the least useful thing a
 * remote-desktop client can say; the backend reports what actually happened
 * (refused, timed out, closed by the other end) and that is what is shown,
 * with the obvious next step beside it.
 *
 * **The keyboard.** Whatever jterm has a shortcut for is jterm's — `Cmd+W`
 * still closes this pane, the same as in a terminal — and every other key
 * goes to the remote machine. `Ctrl+Alt+Del`, which no operating system will
 * let a window have, is a button.
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type RFB from "@novnc/novnc";
import { Eye, Keyboard, Maximize2, MonitorSmartphone, Power, RotateCw, Scan } from "lucide-react";

import { readClipboard, writeClipboard } from "@/lib/clipboard";
import { vnc } from "@/lib/ipc";
import { isMacOS } from "@/lib/platform";
import { formatVncAddress, parseVncAddress, VNC_PORT } from "@/lib/vncAddress";
import { TauriSocket, type Transport } from "@/lib/vncSocket";
import { cn } from "@/lib/utils";
import type { VncPaneState } from "@/state/workspace";
import type { PaneProps } from "./types";

type Status =
  | { kind: "connecting" }
  | { kind: "credentials"; username: boolean }
  | { kind: "connected" }
  | { kind: "closed"; reason: string }
  | { kind: "failed"; reason: string };

export function VncPane({ pane, focused, onMeta, onFocus }: PaneProps<VncPaneState>) {
  const metaRef = useRef(onMeta);
  metaRef.current = onMeta;

  if (!pane.host) {
    return (
      <div className="h-full w-full bg-surface-0" onMouseDown={onFocus}>
        <AddressForm
          onConnect={(address) => metaRef.current({ host: address.host, port: address.port })}
        />
      </div>
    );
  }
  return (
    <Viewer
      // A new address is a new connection, and a new viewer to go with it.
      key={`${pane.host}:${pane.port ?? VNC_PORT}`}
      pane={pane as VncPaneState & { host: string }}
      focused={focused}
      onMeta={(patch) => metaRef.current(patch)}
      onFocus={onFocus}
    />
  );
}

function Viewer({
  pane,
  focused,
  onMeta,
  onFocus,
}: {
  pane: VncPaneState & { host: string };
  focused: boolean;
  onMeta: (patch: Partial<VncPaneState>) => void;
  onFocus: () => void;
}) {
  const screenRef = useRef<HTMLDivElement | null>(null);
  const rfbRef = useRef<RFB | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "connecting" });
  // Bumped to reconnect to the same address.
  const [attempt, setAttempt] = useState(0);
  const port = pane.port ?? VNC_PORT;
  const label = formatVncAddress({ host: pane.host, port });
  const fit = pane.scale !== "actual";
  const viewOnly = pane.viewOnly === true;
  const onMetaRef = useRef(onMeta);
  onMetaRef.current = onMeta;

  useEffect(() => {
    const screen = screenRef.current;
    if (screen === null) return;
    let cancelled = false;
    let rfb: RFB | null = null;
    // Why the connection ended, in the backend's words. noVNC takes over the
    // socket's own close handler, so the reason is caught on its way in.
    let reason = "";

    setStatus({ kind: "connecting" });
    const base = vnc.transport(pane.id, pane.host, port);
    const transport: Transport = {
      open: (onMessage) =>
        base
          .open((message) => {
            if (!(message instanceof ArrayBuffer)) reason = message.closed;
            onMessage(message);
          })
          .catch((error: unknown) => {
            reason = error instanceof Error ? error.message : String(error);
            throw error;
          }),
      send: base.send,
      close: base.close,
    };

    // Loaded when the first VNC pane is, rather than with the app: most
    // people never open one, and noVNC is not small.
    void import("@novnc/novnc").then(({ default: RFBClass }) => {
      if (cancelled) return;
      const socket = new TauriSocket(transport);
      rfb = new RFBClass(screen, socket, { shared: true });
      rfbRef.current = rfb;
      rfb.scaleViewport = fit;
      rfb.clipViewport = !fit;
      rfb.viewOnly = viewOnly;
      // The remote screen keeps its own size; a pane being dragged narrower is
      // not a reason to change somebody's display resolution.
      rfb.resizeSession = false;
      rfb.background = "transparent";

      rfb.addEventListener("connect", () => setStatus({ kind: "connected" }));
      rfb.addEventListener("disconnect", (event) => {
        const clean = (event as CustomEvent<{ clean: boolean }>).detail?.clean;
        setStatus((current) =>
          current.kind === "failed"
            ? current
            : clean
              ? { kind: "closed", reason: reason || "Disconnected." }
              : { kind: "failed", reason: reason || "The connection was lost." },
        );
      });
      rfb.addEventListener("credentialsrequired", (event) => {
        const types = (event as CustomEvent<{ types: string[] }>).detail?.types ?? ["password"];
        setStatus({ kind: "credentials", username: types.includes("username") });
      });
      rfb.addEventListener("securityfailure", (event) => {
        const detail = (event as CustomEvent<{ reason?: string }>).detail;
        setStatus({
          kind: "failed",
          reason: detail?.reason || "The password was not accepted.",
        });
      });
      rfb.addEventListener("desktopname", (event) => {
        const name = (event as CustomEvent<{ name: string }>).detail?.name;
        if (name) onMetaRef.current({ title: name.slice(0, 200) });
      });
      // The remote clipboard, onto this machine's, so copying over there and
      // pasting here works the way it would between two windows.
      rfb.addEventListener("clipboard", (event) => {
        const text = (event as CustomEvent<{ text: string }>).detail?.text;
        if (text) void writeClipboard(text);
      });
    });

    return () => {
      cancelled = true;
      rfb?.disconnect();
      rfbRef.current = null;
    };
    // `fit` and `viewOnly` are applied live below rather than by reconnecting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.host, port, attempt]);

  useEffect(() => {
    const rfb = rfbRef.current;
    if (rfb === null) return;
    rfb.scaleViewport = fit;
    rfb.clipViewport = !fit;
  }, [fit]);

  useEffect(() => {
    if (rfbRef.current !== null) rfbRef.current.viewOnly = viewOnly;
  }, [viewOnly]);

  // Focus follows the pane, and arriving brings this machine's clipboard
  // with it — the other half of the clipboard event above.
  useEffect(() => {
    const rfb = rfbRef.current;
    if (!focused || rfb === null || status.kind !== "connected") return;
    rfb.focus();
    if (!viewOnly) {
      void readClipboard()
        .then((text) => {
          if (text) rfbRef.current?.clipboardPasteFrom(text);
        })
        .catch(() => {});
    }
  }, [focused, status.kind, viewOnly]);

  const reconnect = useCallback(() => setAttempt((n) => n + 1), []);

  return (
    <div className="flex h-full w-full flex-col bg-surface-0" onMouseDown={onFocus}>
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border bg-surface-1 px-1.5">
        <button
          type="button"
          title="Connect somewhere else"
          onClick={() => onMeta({ host: undefined, port: undefined, title: undefined })}
          className="flex min-w-0 items-center gap-1.5 rounded-sm px-1.5 py-0.5 hover:bg-surface-2"
        >
          <StatusDot status={status} />
          <span className="truncate font-mono text-[length:var(--fs-11)] text-ink-2">{label}</span>
        </button>
        <span className="flex-1" />
        <ToolButton
          label={fit ? "Show at actual size" : "Fit to the pane"}
          onClick={() => onMeta({ scale: fit ? "actual" : undefined })}
        >
          {fit ? <Scan className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </ToolButton>
        <ToolButton
          label={viewOnly ? "Allow control" : "View only — send no keys or clicks"}
          active={viewOnly}
          onClick={() => onMeta({ viewOnly: viewOnly ? undefined : true })}
        >
          <Eye className="h-3.5 w-3.5" />
        </ToolButton>
        <ToolButton
          label="Send Ctrl+Alt+Del"
          disabled={status.kind !== "connected" || viewOnly}
          onClick={() => rfbRef.current?.sendCtrlAltDel()}
        >
          <Keyboard className="h-3.5 w-3.5" />
        </ToolButton>
        {status.kind === "connected" || status.kind === "connecting" ? (
          <ToolButton label="Disconnect" onClick={() => rfbRef.current?.disconnect()}>
            <Power className="h-3.5 w-3.5" />
          </ToolButton>
        ) : (
          <ToolButton label="Reconnect" onClick={reconnect}>
            <RotateCw className="h-3.5 w-3.5" />
          </ToolButton>
        )}
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {/* noVNC owns this element: it puts its canvas inside and sizes it. */}
        <div ref={screenRef} className="absolute inset-0" />

        {status.kind === "connecting" ? (
          <Overlay>
            <p className="text-[length:var(--fs-11)] text-ink-3">Connecting to {label}…</p>
          </Overlay>
        ) : status.kind === "credentials" ? (
          <Overlay>
            <CredentialsForm
              label={label}
              username={status.username}
              onSubmit={(credentials) => {
                setStatus({ kind: "connecting" });
                rfbRef.current?.sendCredentials(credentials);
              }}
            />
          </Overlay>
        ) : status.kind === "closed" || status.kind === "failed" ? (
          <Overlay>
            <div className="max-w-[340px] text-center">
              <p
                className={cn(
                  "text-[length:var(--fs-11)]",
                  status.kind === "failed" ? "text-danger" : "text-ink-2",
                )}
              >
                {status.reason}
              </p>
              <div className="mt-2 flex justify-center gap-1.5">
                <SmallButton primary onClick={reconnect}>
                  Reconnect
                </SmallButton>
                <SmallButton
                  onClick={() => onMeta({ host: undefined, port: undefined, title: undefined })}
                >
                  Another address
                </SmallButton>
              </div>
            </div>
          </Overlay>
        ) : null}
      </div>
    </div>
  );
}

function AddressForm({ onConnect }: { onConnect: (address: { host: string; port: number }) => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const address = parseVncAddress(text);
    if (address === null) {
      setError("That does not look like an address. Try a name, an IP, or name:display.");
      return;
    }
    onConnect(address);
  };

  return (
    <form onSubmit={submit} className="mx-auto flex max-w-[420px] flex-col gap-2 px-5 pt-[12vh]">
      <div className="flex items-center gap-2 text-[length:var(--fs-13)] text-ink-1">
        <MonitorSmartphone className="h-4 w-4 text-brand" />
        Remote desktop (VNC)
      </div>
      <p className="text-[length:var(--fs-11)] leading-relaxed text-ink-3">
        Another computer&apos;s screen, in this pane. Give its name or address — add{" "}
        <code className="font-mono text-ink-2">:1</code> for display 1, or{" "}
        <code className="font-mono text-ink-2">::5905</code> for a port.
      </p>
      <input
        autoFocus
        value={text}
        spellCheck={false}
        aria-label="Address"
        placeholder="studio.local, 10.0.0.7:1, vnc://…"
        onChange={(event) => {
          setText(event.target.value);
          setError(null);
        }}
        className="border border-hairline-strong bg-surface-2 px-2 py-1.5 font-mono text-[length:var(--fs-11)] text-ink-1 outline-none focus:border-brand"
      />
      {error ? <p className="text-[length:var(--fs-10)] text-danger">{error}</p> : null}
      <div>
        <SmallButton primary submit>
          Connect
        </SmallButton>
      </div>
      <p className="mt-2 text-[length:var(--fs-10)] leading-relaxed text-ink-4">
        {isMacOS()
          ? "To reach a Mac, turn on Screen Sharing there: System Settings → General → Sharing."
          : "The other computer needs a VNC server running — on a Mac, Screen Sharing; on Linux, GNOME Remote Desktop or a VNC server such as TigerVNC."}{" "}
        Traffic is not encrypted unless the server does it, so outside your own network, reach it
        through ssh or a VPN.
      </p>
    </form>
  );
}

function CredentialsForm({
  label,
  username,
  onSubmit,
}: {
  label: string;
  username: boolean;
  onSubmit: (credentials: { username?: string; password: string }) => void;
}) {
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  return (
    <form
      className="flex w-[260px] flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(username ? { username: user, password } : { password });
      }}
    >
      <p className="text-[length:var(--fs-11)] text-ink-2">{label} is asking you to sign in.</p>
      {username ? (
        <input
          autoFocus
          value={user}
          aria-label="User name"
          placeholder="User name"
          autoComplete="username"
          onChange={(event) => setUser(event.target.value)}
          className="border border-hairline-strong bg-surface-2 px-2 py-1 text-[length:var(--fs-11)] text-ink-1 outline-none focus:border-brand"
        />
      ) : null}
      <input
        autoFocus={!username}
        type="password"
        value={password}
        aria-label="Password"
        placeholder="Password"
        autoComplete="current-password"
        onChange={(event) => setPassword(event.target.value)}
        className="border border-hairline-strong bg-surface-2 px-2 py-1 text-[length:var(--fs-11)] text-ink-1 outline-none focus:border-brand"
      />
      <p className="text-[length:var(--fs-10)] text-ink-4">
        Sent to {label} and not kept — a reconnect asks again.
      </p>
      <div>
        <SmallButton primary submit>
          Sign in
        </SmallButton>
      </div>
    </form>
  );
}

function StatusDot({ status }: { status: Status }) {
  return (
    <span
      aria-hidden
      className={cn(
        "h-1.5 w-1.5 shrink-0 rounded-full",
        status.kind === "connected"
          ? "bg-[#30d158]"
          : status.kind === "failed"
            ? "bg-danger"
            : status.kind === "closed"
              ? "bg-ink-4"
              : "animate-pulse bg-brand",
      )}
    />
  );
}

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-surface-0/85 p-4">
      {children}
    </div>
  );
}

function ToolButton({
  label,
  onClick,
  disabled = false,
  active = false,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm",
        disabled
          ? "text-ink-4"
          : active
            ? "bg-surface-3 text-brand"
            : "text-ink-3 hover:bg-surface-2 hover:text-ink-1",
      )}
    >
      {children}
    </button>
  );
}

function SmallButton({
  children,
  onClick,
  primary = false,
  submit = false,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  primary?: boolean;
  submit?: boolean;
}) {
  return (
    <button
      type={submit ? "submit" : "button"}
      onClick={onClick}
      className={cn(
        "px-3 py-1 text-[length:var(--fs-11)]",
        primary
          ? "bg-brand text-brand-foreground hover:opacity-90"
          : "border border-hairline-strong text-ink-2 hover:bg-surface-2 hover:text-ink-1",
      )}
    >
      {children}
    </button>
  );
}
