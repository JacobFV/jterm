/**
 * A Remote Desktop session, in a pane.
 *
 * The protocol runs in the backend (`rdp.rs`, on IronRDP); this pane draws the
 * rectangles it sends onto a canvas and sends the pointer and the keyboard
 * back. See `lib/rdp.ts` for the wire format.
 *
 * **Sign-in is a form, every time the pane is new to this run.** The address,
 * user and domain are kept with the pane; the password is held in memory for
 * as long as the pane is open, so Reconnect works, and is never written down.
 * A pane restored after a restart therefore opens on the sign-in form with
 * everything filled in but the password.
 *
 * **The certificate is a question, the first time and whenever it changes.**
 * The backend stops before the password is sent and hands over the server's
 * fingerprint; trusting it is remembered with the pane, and a reconnect then
 * goes straight through. A *changed* fingerprint is shown as the warning it
 * is — the usual cause is a reinstalled server, and the other cause is
 * someone in the middle.
 *
 * **The desktop is the pane's size when it connects.** Resizing the pane
 * afterwards scales the picture rather than renegotiating the session; a
 * reconnect picks up the new size.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Keyboard, Maximize2, Power, RotateCw, Scan, ShieldAlert, ShieldCheck } from "lucide-react";

import { rdp } from "@/lib/ipc";
import {
  RDP_PORT,
  coalesce,
  decodeRect,
  formatRdpAddress,
  parseRdpAddress,
  type RdpEvent,
  type RdpInput,
} from "@/lib/rdp";
import { scancodeFor } from "@/lib/scancodes";
import { cn } from "@/lib/utils";
import type { RdpPaneState } from "@/state/workspace";
import type { PaneProps } from "./types";

type Status =
  | { kind: "connecting" }
  | { kind: "connected"; width: number; height: number }
  | { kind: "untrusted"; fingerprint: string; changed: boolean }
  | { kind: "closed"; reason: string };

export function RdpPane({ pane, focused, onMeta, onFocus }: PaneProps<RdpPaneState>) {
  // The one secret, in memory only. See the file comment.
  const [password, setPassword] = useState<string | null>(null);

  if (!pane.host || password === null) {
    return (
      <div className="h-full w-full overflow-auto bg-surface-0" onMouseDown={onFocus}>
        <SignInForm
          pane={pane}
          onSubmit={({ address, username, domain, password: secret }) => {
            onMeta({
              host: address.host,
              port: address.port,
              username,
              domain: domain || undefined,
              // A different server is a different certificate.
              trusted: address.host === pane.host ? pane.trusted : undefined,
            });
            setPassword(secret);
          }}
        />
      </div>
    );
  }

  return (
    <Session
      pane={pane as RdpPaneState & { host: string }}
      password={password}
      focused={focused}
      onMeta={onMeta}
      onFocus={onFocus}
      onSignOut={() => setPassword(null)}
    />
  );
}

function Session({
  pane,
  password,
  focused,
  onMeta,
  onFocus,
  onSignOut,
}: {
  pane: RdpPaneState & { host: string };
  password: string;
  focused: boolean;
  onMeta: (patch: Partial<RdpPaneState>) => void;
  onFocus: () => void;
  onSignOut: () => void;
}) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "connecting" });
  const [attempt, setAttempt] = useState(0);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const port = pane.port ?? RDP_PORT;
  const label = formatRdpAddress({ host: pane.host, port });
  const fit = pane.scale !== "actual";
  const generationRef = useRef<number | null>(null);
  const trustedRef = useRef(pane.trusted);
  trustedRef.current = pane.trusted;

  // The frame's size: the desktop is asked for at this size, and the picture
  // is fitted into it afterwards.
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (frame === null) return;
    const observer = new ResizeObserver(() =>
      setBox({ width: frame.clientWidth, height: frame.clientHeight }),
    );
    observer.observe(frame);
    setBox({ width: frame.clientWidth, height: frame.clientHeight });
    return () => observer.disconnect();
  }, []);

  /* ── The connection ─────────────────────────────────────────────── */

  const sizeRef = useRef(box);
  sizeRef.current = box;

  useEffect(() => {
    // Wait for a measured frame: a desktop asked for at 0×0 would be clamped
    // to the minimum and look wrong for the whole session.
    if (sizeRef.current.width === 0) return;
    let live = true;
    // Which session this effect opened; closing names it, so a reconnect's
    // close cannot end the session that replaced it.
    let generation: number | null = null;
    setStatus({ kind: "connecting" });
    const id = pane.id;
    void rdp
      .connect(
        id,
        {
          host: pane.host,
          port,
          username: pane.username ?? "",
          password,
          domain: pane.domain,
          trusted: trustedRef.current,
          width: Math.round(sizeRef.current.width),
          height: Math.round(sizeRef.current.height),
        },
        (message) => {
          if (!live) return;
          if (message instanceof ArrayBuffer) {
            draw(canvasRef.current, message);
            return;
          }
          const event = message as RdpEvent;
          if ("connected" in event) {
            const canvas = canvasRef.current;
            if (canvas) {
              canvas.width = event.connected.width;
              canvas.height = event.connected.height;
            }
            setStatus({ kind: "connected", ...event.connected });
          } else if ("untrusted" in event) {
            setStatus({ kind: "untrusted", ...event.untrusted });
          } else if ("closed" in event) {
            // An empty reason follows `untrusted`: the session stopped to ask,
            // and the question is what should stay on screen.
            if (event.closed) setStatus({ kind: "closed", reason: event.closed });
          }
        },
      )
      .then((opened) => {
        generation = opened;
        generationRef.current = opened;
        if (!live) void rdp.close(id, opened);
      })
      .catch((error: unknown) => {
        if (live) setStatus({ kind: "closed", reason: String(error) });
      });
    return () => {
      live = false;
      if (generation !== null) void rdp.close(id, generation);
    };
    // `box` is read through a ref: resizing the pane must not reconnect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id, pane.host, port, password, attempt, box.width === 0]);

  const reconnect = useCallback(() => setAttempt((n) => n + 1), []);

  /* ── Input ─────────────────────────────────────────────────────── */

  // One request in flight at a time, and whatever arrives meanwhile goes in
  // the next — so the order survives and a drag is not a queue of requests.
  const pending = useRef<RdpInput[]>([]);
  const sending = useRef(false);
  const send = useCallback(
    (events: RdpInput[]) => {
      pending.current.push(...events);
      if (sending.current) return;
      const pump = () => {
        const batch = coalesce(pending.current);
        pending.current = [];
        if (batch.length === 0) {
          sending.current = false;
          return;
        }
        sending.current = true;
        void rdp.input(pane.id, batch).finally(pump);
      };
      pump();
    },
    [pane.id],
  );

  const connected = status.kind === "connected";
  const desktop = connected ? { width: status.width, height: status.height } : null;

  // Where the canvas sits in the frame, and how much it is scaled by.
  const scale =
    desktop === null
      ? 1
      : fit
        ? Math.min(box.width / desktop.width, box.height / desktop.height, 1)
        : 1;

  const toDesktop = (event: React.MouseEvent | React.WheelEvent) => {
    const canvas = canvasRef.current;
    if (canvas === null || desktop === null) return null;
    const rect = canvas.getBoundingClientRect();
    const x = Math.round(((event.clientX - rect.left) / rect.width) * desktop.width);
    const y = Math.round(((event.clientY - rect.top) / rect.height) * desktop.height);
    return {
      x: Math.max(0, Math.min(desktop.width - 1, x)),
      y: Math.max(0, Math.min(desktop.height - 1, y)),
    };
  };

  const pointer = (event: React.MouseEvent, button?: { down: boolean }) => {
    const at = toDesktop(event);
    if (at === null) return;
    const events: RdpInput[] = [{ kind: "move", ...at }];
    if (button) events.push({ kind: "button", button: event.button, down: button.down });
    send(events);
  };

  useEffect(() => {
    if (focused && connected) canvasRef.current?.focus();
  }, [focused, connected]);

  const sendCtrlAltDel = () =>
    send([
      { kind: "key", scancode: 0x1d, down: true },
      { kind: "key", scancode: 0x38, down: true },
      { kind: "key", scancode: 0xe053, down: true },
      { kind: "key", scancode: 0xe053, down: false },
      { kind: "key", scancode: 0x38, down: false },
      { kind: "key", scancode: 0x1d, down: false },
    ]);

  return (
    <div className="flex h-full w-full flex-col bg-surface-0" onMouseDown={onFocus}>
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border bg-surface-1 px-1.5">
        <button
          type="button"
          title="Connect somewhere else"
          onClick={onSignOut}
          className="flex min-w-0 items-center gap-1.5 rounded-sm px-1.5 py-0.5 hover:bg-surface-2"
        >
          <span
            aria-hidden
            className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full",
              connected
                ? "bg-[#30d158]"
                : status.kind === "closed"
                  ? "bg-ink-4"
                  : "animate-pulse bg-brand",
            )}
          />
          <span className="truncate font-mono text-[length:var(--fs-11)] text-ink-2">
            {pane.username ? `${pane.username}@${label}` : label}
          </span>
        </button>
        {pane.trusted ? (
          <span title={`Certificate trusted: ${pane.trusted}`} className="text-ink-4">
            <ShieldCheck className="h-3 w-3" />
          </span>
        ) : null}
        <span className="flex-1" />
        <ToolButton
          label={fit ? "Show at actual size" : "Fit to the pane"}
          onClick={() => onMeta({ scale: fit ? "actual" : undefined })}
        >
          {fit ? <Scan className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </ToolButton>
        <ToolButton label="Send Ctrl+Alt+Del" disabled={!connected} onClick={sendCtrlAltDel}>
          <Keyboard className="h-3.5 w-3.5" />
        </ToolButton>
        {status.kind === "closed" ? (
          <ToolButton label="Reconnect" onClick={reconnect}>
            <RotateCw className="h-3.5 w-3.5" />
          </ToolButton>
        ) : (
          <ToolButton
            label="Disconnect"
            onClick={() => void rdp.close(pane.id, generationRef.current)}
          >
            <Power className="h-3.5 w-3.5" />
          </ToolButton>
        )}
      </div>

      <div
        ref={frameRef}
        className={cn(
          "relative min-h-0 flex-1",
          fit ? "flex items-center justify-center overflow-hidden" : "overflow-auto",
        )}
      >
        <canvas
          ref={canvasRef}
          tabIndex={0}
          aria-label={`Remote desktop: ${label}`}
          className={cn("block outline-none", !connected && "invisible")}
          style={
            desktop
              ? { width: desktop.width * scale, height: desktop.height * scale, cursor: "default" }
              : undefined
          }
          onMouseMove={(event) => pointer(event)}
          onMouseDown={(event) => {
            canvasRef.current?.focus();
            pointer(event, { down: true });
          }}
          onMouseUp={(event) => pointer(event, { down: false })}
          onContextMenu={(event) => event.preventDefault()}
          onWheel={(event) => {
            if (event.deltaY !== 0) {
              send([{ kind: "wheel", vertical: true, units: -Math.sign(event.deltaY) * 120 }]);
            }
            if (event.deltaX !== 0) {
              send([{ kind: "wheel", vertical: false, units: Math.sign(event.deltaX) * 120 }]);
            }
          }}
          onKeyDown={(event) => {
            const scancode = scancodeFor(event.code);
            if (scancode === null) return;
            event.preventDefault();
            send([{ kind: "key", scancode, down: true }]);
          }}
          onKeyUp={(event) => {
            const scancode = scancodeFor(event.code);
            if (scancode === null) return;
            event.preventDefault();
            send([{ kind: "key", scancode, down: false }]);
          }}
          // A key held as focus leaves would otherwise stay down over there.
          onBlur={() => send([{ kind: "releaseAll" }])}
        />

        {status.kind === "connecting" ? (
          <Overlay>
            <p className="text-[length:var(--fs-11)] text-ink-3">Connecting to {label}…</p>
          </Overlay>
        ) : status.kind === "untrusted" ? (
          <Overlay>
            <CertificateQuestion
              label={label}
              fingerprint={status.fingerprint}
              changed={status.changed}
              onTrust={() => {
                onMeta({ trusted: status.fingerprint });
                trustedRef.current = status.fingerprint;
                reconnect();
              }}
              onCancel={onSignOut}
            />
          </Overlay>
        ) : status.kind === "closed" ? (
          <Overlay>
            <div className="max-w-[360px] text-center">
              <p className="text-[length:var(--fs-11)] text-ink-2">{status.reason}</p>
              <div className="mt-2 flex justify-center gap-1.5">
                <SmallButton primary onClick={reconnect}>
                  Reconnect
                </SmallButton>
                <SmallButton onClick={onSignOut}>Sign in differently</SmallButton>
              </div>
            </div>
          </Overlay>
        ) : null}
      </div>
    </div>
  );
}

function draw(canvas: HTMLCanvasElement | null, buffer: ArrayBuffer) {
  const rect = decodeRect(buffer);
  const context = canvas?.getContext("2d");
  if (rect === null || !context) return;
  context.putImageData(new ImageData(rect.pixels, rect.width, rect.height), rect.x, rect.y);
}

function CertificateQuestion({
  label,
  fingerprint,
  changed,
  onTrust,
  onCancel,
}: {
  label: string;
  fingerprint: string;
  changed: boolean;
  onTrust: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="w-[min(420px,100%)] border border-hairline-strong bg-surface-1 p-3">
      <p
        className={cn(
          "flex items-center gap-1.5 text-[length:var(--fs-12)]",
          changed ? "text-danger" : "text-ink-1",
        )}
      >
        {changed ? <ShieldAlert className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
        {changed ? `${label}'s certificate has changed` : `First time connecting to ${label}`}
      </p>
      <p className="mt-1 text-[length:var(--fs-105)] leading-relaxed text-ink-3">
        {changed
          ? "This is not the certificate you trusted before. A reinstalled or renamed server explains it; so would someone in between you and it. Your password has not been sent."
          : "Remote Desktop servers usually sign their own certificates, so there is no authority to vouch for this one. Nothing has been sent yet. If you can, compare this with the server's — then trust it, and jterm will notice if it ever changes."}
      </p>
      <code className="mt-2 block break-all bg-surface-2 px-2 py-1 font-mono text-[length:var(--fs-10)] leading-relaxed text-ink-1">
        {fingerprint}
      </code>
      <div className="mt-2 flex gap-1.5">
        <SmallButton primary onClick={onTrust}>
          {changed ? "Trust the new certificate" : "Trust and connect"}
        </SmallButton>
        <SmallButton onClick={onCancel}>Cancel</SmallButton>
      </div>
    </div>
  );
}

function SignInForm({
  pane,
  onSubmit,
}: {
  pane: RdpPaneState;
  onSubmit: (values: {
    address: { host: string; port: number };
    username: string;
    domain: string;
    password: string;
  }) => void;
}) {
  const [address, setAddress] = useState(
    pane.host ? formatRdpAddress({ host: pane.host, port: pane.port ?? RDP_PORT }) : "",
  );
  const [username, setUsername] = useState(pane.username ?? "");
  const [domain, setDomain] = useState(pane.domain ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseRdpAddress(address);
    if (parsed === null) {
      setError("That does not look like an address. Try a name, an IP, or name:port.");
      return;
    }
    if (!username) {
      setError("Remote Desktop needs a user name to sign in with.");
      return;
    }
    onSubmit({ address: parsed, username, domain, password });
  };

  const field =
    "border border-hairline-strong bg-surface-2 px-2 py-1.5 text-[length:var(--fs-11)] text-ink-1 outline-none focus:border-brand";

  return (
    <form onSubmit={submit} className="mx-auto flex max-w-[420px] flex-col gap-2 px-5 py-[10vh]">
      <div className="flex items-center gap-2 text-[length:var(--fs-13)] text-ink-1">
        <Maximize2 className="h-4 w-4 text-brand" />
        Remote Desktop (RDP)
      </div>
      <p className="text-[length:var(--fs-11)] leading-relaxed text-ink-3">
        A Windows desktop — or any machine running an RDP server — in this pane. The password is
        used for this session and never saved.
      </p>
      <input
        autoFocus={!pane.host}
        value={address}
        spellCheck={false}
        aria-label="Address"
        placeholder="winbox.local, 10.0.0.9, rdp://…"
        onChange={(event) => {
          setAddress(event.target.value);
          setError(null);
        }}
        className={cn(field, "font-mono")}
      />
      <div className="flex gap-2">
        <input
          value={username}
          spellCheck={false}
          aria-label="User name"
          placeholder="User name"
          autoComplete="username"
          onChange={(event) => setUsername(event.target.value)}
          className={cn(field, "min-w-0 flex-1")}
        />
        <input
          value={domain}
          spellCheck={false}
          aria-label="Domain"
          placeholder="Domain (optional)"
          onChange={(event) => setDomain(event.target.value)}
          className={cn(field, "min-w-0 flex-1")}
        />
      </div>
      <input
        autoFocus={Boolean(pane.host)}
        type="password"
        value={password}
        aria-label="Password"
        placeholder="Password"
        autoComplete="current-password"
        onChange={(event) => setPassword(event.target.value)}
        className={field}
      />
      {error ? <p className="text-[length:var(--fs-10)] text-danger">{error}</p> : null}
      <div>
        <SmallButton primary submit>
          Connect
        </SmallButton>
      </div>
      <p className="mt-2 text-[length:var(--fs-10)] leading-relaxed text-ink-4">
        On the Windows machine: Settings → System → Remote Desktop. The first time, jterm shows the
        server&apos;s certificate fingerprint and asks before your password is sent.
      </p>
    </form>
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
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm",
        disabled ? "text-ink-4" : "text-ink-3 hover:bg-surface-2 hover:text-ink-1",
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
