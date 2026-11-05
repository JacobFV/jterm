/**
 * Settings → Sharing: what this computer makes available, and how to change it.
 *
 * Written to be read by someone deciding whether to turn something on, so each
 * service says three things before it offers a switch: what it hands over, to
 * whom, and from how far away. The switches themselves are the operating
 * system's — see `sharing.rs` for why jterm does not hold them — so the button
 * opens the right page, and the panel checks again when you come back to it.
 *
 * Everything here is worded in `lib/sharing.ts`, where it is tested; this is
 * only the drawing.
 */

import { useCallback, useEffect, useState } from "react";
import { Copy, ExternalLink, RotateCw, ShieldAlert } from "lucide-react";

import { writeClipboard } from "@/lib/clipboard";
import { sharing } from "@/lib/ipc";
import { isMacOS, isWindows } from "@/lib/platform";
import {
  REACH_LABEL,
  SERVICE_GIVES,
  SERVICE_NAME,
  connectLine,
  whoMaySignIn,
  nativeServices,
  reachOf,
  summary,
  widestReach,
  type Service,
  type ServiceStatus,
  type SharingStatus,
} from "@/lib/sharing";
import { cn } from "@/lib/utils";
import { Button, Section } from "./controls";

const PLATFORM = isMacOS() ? "macos" : isWindows() ? "windows" : "linux";

/** Where the switch is, for when opening it did not work. */
const WHERE: Record<typeof PLATFORM, Record<Service, string>> = {
  macos: {
    ssh: "System Settings → General → Sharing → Remote Login",
    vnc: "System Settings → General → Sharing → Screen Sharing",
    rdp: "",
  },
  windows: {
    ssh: "Settings → System → Optional features → OpenSSH Server",
    vnc: "",
    rdp: "Settings → System → Remote Desktop",
  },
  linux: {
    ssh: "your distribution's sshd service (systemctl enable --now ssh)",
    vnc: "Settings → System → Remote Desktop (GNOME)",
    rdp: "Settings → System → Remote Desktop (GNOME)",
  },
};

/** What the platform uses instead, for the service it has no server for. */
const MISSING: Partial<Record<Service, string>> = {
  rdp: "macOS has no Remote Desktop server. Screen sharing above is the Mac's way to be reached, and jterm's VNC panes — or any VNC viewer — can open it.",
  vnc: "Windows has no VNC server of its own. Remote Desktop below is Windows' way to be reached.",
};

export function SharingPanel() {
  const [status, setStatus] = useState<SharingStatus | null>(null);
  const [checking, setChecking] = useState(true);

  const refresh = useCallback(async () => {
    setChecking(true);
    setStatus(await sharing.status());
    setChecking(false);
  }, []);

  // Again whenever this window comes back to the front — which is what
  // happens after the trip to System Settings the buttons below send you on.
  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  if (status === null) {
    return (
      <Section title="Sharing">
        <p className="text-[length:var(--fs-11)] text-ink-3">
          {checking ? "Checking what this computer shares…" : "Sharing can only be checked in the jterm app."}
        </p>
      </Section>
    );
  }

  const native = nativeServices(PLATFORM);
  const anyOn = status.services.some((service) => service.listening);
  const widest = widestReach(status.addresses);

  return (
    <>
      <Section title="Sharing">
        <div
          className={cn(
            "flex items-start gap-2 border px-3 py-2",
            anyOn ? "border-brand/60 bg-brand/10" : "border-hairline-strong bg-surface-1",
          )}
        >
          <span
            aria-hidden
            className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", anyOn ? "bg-brand" : "bg-ink-4")}
          />
          <div className="min-w-0 flex-1">
            <p className="text-[length:var(--fs-125)] text-ink-1">{summary(status)}</p>
            <p className="mt-0.5 text-[length:var(--fs-105)] leading-relaxed text-ink-3">
              jterm runs no server of its own. Everything here is your operating system&apos;s,
              and is switched on and off in its settings.
            </p>
          </div>
          <button
            type="button"
            title="Check again"
            aria-label="Check again"
            onClick={() => void refresh()}
            className="shrink-0 rounded-sm p-1 text-ink-3 hover:bg-surface-2 hover:text-ink-1"
          >
            <RotateCw className={cn("h-3.5 w-3.5", checking && "animate-spin")} />
          </button>
        </div>

        <div>
          <div className="pane-title mb-1.5 text-[length:var(--fs-9)]">Others reach it at</div>
          <ul className="space-y-0.5">
            {status.hostName ? (
              <AddressRow address={status.hostName} reach="on this network, by name" />
            ) : null}
            {status.addresses.map((address) => (
              <AddressRow key={address} address={address} reach={REACH_LABEL[reachOf(address)]} />
            ))}
          </ul>
          {anyOn && widest === "internet" ? (
            <p className="mt-2 flex items-start gap-1.5 text-[length:var(--fs-105)] leading-relaxed text-danger">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              This computer has a public address. Unless a firewall or your router stops it, what is
              shared here can be reached from the internet — sign-ins included.
            </p>
          ) : null}
        </div>
      </Section>

      {(["ssh", "vnc", "rdp"] as const).map((service) => {
        const found = status.services.find((candidate) => candidate.service === service);
        if (found === undefined) return null;
        // A service this platform has no server for is mentioned only when it
        // is somehow on — a third-party server — or to say what to use instead.
        if (!native.includes(service) && !found.listening) {
          return MISSING[service] && PLATFORM !== "linux" ? (
            <Section key={service} title={SERVICE_NAME[service]}>
              <p className="text-[length:var(--fs-105)] leading-relaxed text-ink-3">
                {MISSING[service]}
              </p>
            </Section>
          ) : null;
        }
        return <ServiceCard key={service} status={status} service={found} />;
      })}
    </>
  );
}

function AddressRow({ address, reach }: { address: string; reach: string }) {
  return (
    <li className="flex items-baseline gap-2">
      <code className="font-mono text-[length:var(--fs-11)] text-ink-1">{address}</code>
      <span className="text-[length:var(--fs-10)] text-ink-4">{reach}</span>
    </li>
  );
}

function ServiceCard({ status, service }: { status: SharingStatus; service: ServiceStatus }) {
  const [unopened, setUnopened] = useState(false);
  const line = connectLine(status, service.service);
  const where = WHERE[PLATFORM][service.service];

  return (
    <Section title={SERVICE_NAME[service.service]}>
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "px-1.5 py-0.5 text-[length:var(--fs-10)]",
            service.listening ? "bg-[#30d158]/20 text-[#30d158]" : "bg-surface-2 text-ink-3",
          )}
        >
          {service.listening ? "On" : "Off"}
        </span>
        <span className="text-[length:var(--fs-105)] text-ink-3">port {service.port}</span>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[length:var(--fs-105)] leading-relaxed">
        <dt className="text-ink-4">Gives</dt>
        <dd className="text-ink-2">{SERVICE_GIVES[service.service]}</dd>
        {service.listening ? (
          <>
            <dt className="text-ink-4">Who</dt>
            <dd className="text-ink-2">{whoMaySignIn(service, PLATFORM === "macos")}</dd>
            {line ? (
              <>
                <dt className="text-ink-4">Connect</dt>
                <dd className="flex items-center gap-1.5">
                  <code className="font-mono text-ink-1">{line}</code>
                  <button
                    type="button"
                    title="Copy"
                    aria-label="Copy"
                    onClick={() => void writeClipboard(line)}
                    className="rounded-sm p-0.5 text-ink-3 hover:bg-surface-2 hover:text-ink-1"
                  >
                    <Copy className="h-3 w-3" />
                  </button>
                </dd>
              </>
            ) : null}
          </>
        ) : null}
      </dl>

      {service.service === "ssh" && service.listening ? (
        <p className="text-[length:var(--fs-105)] leading-relaxed text-ink-3">
          Another jterm reaches this one with <span className="text-ink-1">+ → Remote host…</span>{" "}
          and opens its tmux sessions as panes there, laid out as they are here.
        </p>
      ) : null}

      {where ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() =>
              void sharing.open(service.service).then((opened) => setUnopened(!opened))
            }
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {service.listening ? "Turn off…" : "Turn on…"}
          </Button>
          <span className="text-[length:var(--fs-10)] text-ink-4">
            {unopened ? `Find it in ${where}.` : `Opens ${where.split(" → ")[0]}.`}
          </span>
        </div>
      ) : null}
    </Section>
  );
}
