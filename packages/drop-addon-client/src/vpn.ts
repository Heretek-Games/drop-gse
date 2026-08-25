/**
 * Mesh VPN interface validation.
 *
 * Backends:
 *  - Tailscale: Local API via `tailscale` CLI / embedded client
 *  - ZeroTier:  service API on http://localhost:9993, auth header `X-ZT1-AUTH`
 *               (token from `authtoken.secret`)
 */

export type MeshBackend = "tailscale" | "zerotier";

export interface MeshStatus {
  online: boolean;
  /** This node's address inside the room subnet. */
  selfAddress?: string;
  /** Peer addresses currently reachable in the room subnet. */
  peers: string[];
}

export interface VpnValidator {
  readonly backend: MeshBackend;
  status(roomCidr: string): Promise<MeshStatus>;
}

export class ZeroTierValidator implements VpnValidator {
  readonly backend: MeshBackend = "zerotier";

  constructor(
    private readonly baseUrl = "http://localhost:9993",
    private readonly authToken: string,
  ) {}

  async status(_roomCidr: string): Promise<MeshStatus> {
    // GET /status then GET /network/<network_id> — see
    // github.com/zerotier/zerotier-one-api-spec (X-ZT1-AUTH header).
    throw new Error("not implemented: scaffold");
  }
}

export class TailscaleValidator implements VpnValidator {
  readonly backend: MeshBackend = "tailscale";

  async status(_roomCidr: string): Promise<MeshStatus> {
    // Prefer Drop's existing embedded tailscale crate (desktop/src-tauri/tailscale)
    // over shelling out to the `tailscale` CLI; fall back to Local API queries.
    throw new Error("not implemented: scaffold");
  }
}
