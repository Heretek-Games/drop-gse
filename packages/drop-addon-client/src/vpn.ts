/**
 * Mesh VPN interface validation.
 *
 * Each backend has its own transport — see `VpnValidator` subclasses.
 *
 * Tailscale: LocalAPI transport is platform-specific:
 *   - Linux:    Unix socket `/var/run/tailscale/tailscaled.sock`
 *               (auth = filesystem permissions / peer UID)
 *   - macOS:    Local TCP fallback + Basic-Auth token via
 *               `safesocket.LocalTCPPortAndToken`
 *   - Windows:  Named pipe `\.\pipe\lantern-provider`
 *   - All:      `tailscale` Go client (`tailscale.com/client/local`) handles
 *               these transparently — preferred over raw HTTP for new code.
 *   - Host header MUST be `local-tailscaled.sock`; `Origin`/`Referer` are
 *     rejected.
 *   - Drop's desktop already exposes a Tailscale C-ABI crate
 *     (`desktop/src-tauri/tailscale/`) — clients should prefer that.
 *
 * ZeroTier:  HTTP service API on `http://localhost:9993`, auth via the
 *   `X-ZT1-AUTH` header whose value is the contents of
 *   `authtoken.secret` (`~/Library/Application Support/ZeroTier/authtoken.secret`
 *   on macOS, `\\ProgramData\\ZeroTier\\One` on Windows,
 *   `/var/lib/zerotier-one/authtoken.secret` on Linux).
 *   See https://github.com/zerotier/zerotier-one-api-spec
 */

export type MeshBackend = "tailscale" | "zerotier";

/** Backend-specific reference for room membership validation. */
export type MeshRoomRef =
  | { backend: "tailscale"; aclTag: string }
  | { backend: "zerotier"; cidr: string; networkId: string };

export interface MeshStatus {
  online: boolean;
  /** This node's address inside the room subnet (ZeroTier) or tailnet. */
  selfAddress?: string;
  /** Peer addresses currently reachable in the room. */
  peers: string[];
  /** Echoes the room ref this validator is bound to, for caller convenience. */
  roomRef: MeshRoomRef;
}

export interface VpnValidator {
  readonly backend: MeshBackend;
  /** Validate that this client is part of the room identified by `ref`. */
  status(ref: MeshRoomRef): Promise<MeshStatus>;
}

/**
 * ZeroTier validator — HTTP service API on localhost:9993, auth via
 * `X-ZT1-AUTH`. The token is read from `authtoken.secret` by the caller.
 */
export class ZeroTierValidator implements VpnValidator {
  readonly backend: MeshBackend = "zerotier";

  constructor(
    private readonly baseUrl = "http://localhost:9993",
    private readonly authToken: string,
  ) {}

  status(ref: MeshRoomRef): Promise<MeshStatus> {
    if (ref.backend !== "zerotier") {
      return Promise.reject(new Error("ZeroTierValidator received non-zerotier MeshRoomRef"));
    }
    // GET /status then GET /network/<network_id> — see
    // github.com/zerotier/zerotier-one-api-spec (X-ZT1-AUTH header).
    return Promise.reject(new Error("not implemented: scaffold"));
  }
}

/**
 * Tailscale validator — platform-specific LocalAPI transport.
 *
 * Drop's desktop embeds the tailscale Go client behind C-ABI bindings; that
 * crate should be preferred over shelling out to the CLI in new code. When
 * the embedded client is unavailable, the LocalAPI is reachable directly on
 * Linux via `/var/run/tailscale/tailscaled.sock` (auth by socket permissions).
 */
export class TailscaleValidator implements VpnValidator {
  readonly backend: MeshBackend = "tailscale";

  constructor(
    /** Platform-specific LocalAPI transport descriptor. */
    private readonly transport: TailscaleLocalAPI,
  ) {}

  status(ref: MeshRoomRef): Promise<MeshStatus> {
    if (ref.backend !== "tailscale") {
      return Promise.reject(new Error("TailscaleValidator received non-tailscale MeshRoomRef"));
    }
    // ListLocalPeers / GetStatus via the LocalAPI; verify node holds `aclTag`.
    return Promise.reject(new Error("not implemented: scaffold"));
  }
}

/**
 * Tailscale LocalAPI transport — platform-specific. Provide only the variant
 * that matches the running host; the validator refuses cross-platform use.
 */
export type TailscaleLocalAPI =
  | { kind: "unix-socket"; path: string }
  | { kind: "named-pipe"; path: string }
  | { kind: "macos-tcp"; port: number; token: string }
  | { kind: "embedded-go" }; // Drop's desktop/src-tauri/tailscale/ crate
