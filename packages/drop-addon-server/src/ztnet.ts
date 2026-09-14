import { allocateMemberAddress, type FetchLike, roomCidr } from "./mesh.js";
import type { IssuedCredential, MeshBackend, PublicMeshInfo } from "./types.js";

export interface ZtnetBackendOptions {
  /** ZTNET base URL, e.g. `http://ztnet:3000`. */
  baseUrl: string;
  /** Organization API token (`x-ztnet-auth`). */
  apiToken: string;
  /** ZTNET organization id that owns the room networks. */
  organizationId: string;
  fetchImpl?: FetchLike;
}

/** Strips trailing slashes without a backtracking-prone regular expression. */
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") {
    end--;
  }
  return value.slice(0, end);
}

interface ZtnetNetworkResponse {
  nwid?: string;
  id?: string;
}

interface ZtnetMemberResponse {
  ipAssignments?: string[];
}

/**
 * ZTNET-managed ZeroTier controller backend.
 *
 * ZTNET sits in front of a self-hosted `zerotier-one` controller. Networks are
 * created via the org API and configured in a second call (the create endpoint
 * only accepts a name); members are authorized by node id. All requests use the
 * `x-ztnet-auth` organization token.
 *
 * Note: ZTNET's network update schema does not expose `enableBroadcast`; LAN
 * discovery is delivered through the module's unicast `custom_broadcasts.txt`.
 */
export class ZtnetBackend implements MeshBackend {
  readonly id = "zerotier" as const;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly baseOrigin: string;
  private readonly networks = new Map<string, string>();
  /** roomId → (userId → member node id), for revocation. */
  private readonly memberIds = new Map<string, Map<string, string>>();

  constructor(private readonly options: ZtnetBackendOptions) {
    this.fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
    this.baseUrl = trimTrailingSlashes(options.baseUrl);
    this.baseOrigin = new URL(this.baseUrl).origin;
  }

  private headers(): Record<string, string> {
    return {
      "x-ztnet-auth": this.options.apiToken,
      "Content-Type": "application/json",
    };
  }

  private orgUrl(suffix = ""): string {
    return `${this.baseUrl}/api/v1/org/${this.options.organizationId}/network${suffix}`;
  }

  private async send(
    url: string,
    init?: {
      method?: string;
      body?: string;
    },
  ): Promise<Awaited<ReturnType<FetchLike>>> {
    // Re-parse every request against the configured base origin so a caller
    // cannot turn room/member ids into a request to another host.
    const target = new URL(url);
    if (target.origin !== this.baseOrigin) {
      throw new Error("ZTNET request URL escaped the configured base URL");
    }
    const response = await this.fetchImpl(target.toString(), {
      method: init?.method ?? "GET",
      headers: this.headers(),
      body: init?.body,
    });
    if (!response.ok) {
      // Already-deleted networks/members are a successful teardown/revoke.
      if (init?.method === "DELETE" && response.status === 404) {
        return response;
      }
      throw new Error(`ZTNET request failed (${response.status}) ${url}: ${await response.text()}`);
    }
    return response;
  }

  /** Send a request and discard any body (used for DELETE). */
  private async request(
    url: string,
    init?: {
      method?: string;
      body?: string;
    },
  ): Promise<void> {
    await this.send(url, init);
  }

  private async json<T>(
    url: string,
    init?: {
      method?: string;
      body?: string;
    },
  ): Promise<T> {
    const response = await this.send(url, init);
    return (await response.json()) as T;
  }

  /**
   * Resolve a room's network id from live state or persisted mesh info, caching
   * it so a restarted coordinator can still authorize/revoke/tear down.
   */
  private networkIdFor(roomId: string, mesh?: PublicMeshInfo): string | undefined {
    const persisted = mesh?.backend === "zerotier" ? mesh.networkId : undefined;
    const networkId = this.networks.get(roomId) ?? persisted;
    if (networkId) this.networks.set(roomId, networkId);
    return networkId;
  }

  async provision(roomId: string, expiresAt: number): Promise<PublicMeshInfo> {
    const created = await this.json<ZtnetNetworkResponse>(this.orgUrl(), {
      method: "POST",
      body: JSON.stringify({ name: `drop-gse-${roomId}` }),
    });
    const networkId = created.nwid ?? created.id;
    if (!networkId) {
      throw new Error("ZTNET network creation returned no network id");
    }

    const cidr = roomCidr(roomId);
    await this.json<ZtnetNetworkResponse>(this.orgUrl(`/${encodeURIComponent(networkId)}`), {
      method: "POST",
      body: JSON.stringify({
        name: `drop-gse-${roomId}`,
        private: true,
        v4AssignMode: { zt: true },
        ipAssignmentPools: [
          {
            ipRangeStart: cidr.replace(/\.0\/24$/, ".1"),
            ipRangeEnd: cidr.replace(/\.0\/24$/, ".254"),
          },
        ],
        routes: [{ target: cidr, via: null }],
      }),
    });

    this.networks.set(roomId, networkId);
    return {
      backend: "zerotier",
      cidr,
      networkId,
      expiresAt,
    };
  }

  async issueCredential(
    roomId: string,
    userId: string,
    mesh: PublicMeshInfo,
  ): Promise<IssuedCredential> {
    if (mesh.backend !== "zerotier") {
      throw new Error("ZtnetBackend received non-zerotier mesh info");
    }
    // The client joins the network with the nwid; ZTNET authorizes the node
    // once it reports its member id (see `authorizeMember`).
    return { secret: `zerotier:${mesh.networkId}:${roomId}:${userId}` };
  }

  async authorizeMember(
    roomId: string,
    userId: string,
    memberId: string,
    mesh?: PublicMeshInfo,
    usedAddresses: string[] = [],
  ): Promise<string | undefined> {
    const networkId = this.networkIdFor(roomId, mesh);
    if (!networkId) return undefined;

    // Assign a deterministic address from the room pool at authorization time;
    // the controller does not auto-assign until the node actually joins, and
    // peers need known addresses for `custom_broadcasts.txt`. Existing
    // assignments are skipped so two members cannot collide.
    const assigned = allocateMemberAddress(roomCidr(roomId), memberId, usedAddresses);

    const member = await this.json<ZtnetMemberResponse>(
      this.orgUrl(`/${encodeURIComponent(networkId)}/member/${encodeURIComponent(memberId)}`),
      {
        method: "POST",
        body: JSON.stringify({
          authorized: true,
          ...(assigned ? { ipAssignments: [assigned] } : {}),
        }),
      },
    );

    const roomMembers = this.memberIds.get(roomId) ?? new Map<string, string>();
    roomMembers.set(userId, memberId);
    this.memberIds.set(roomId, roomMembers);

    // ZTNET returns plain IPs (no CIDR suffix).
    return member.ipAssignments?.[0] ?? assigned;
  }

  async revokeMember(
    roomId: string,
    userId: string,
    mesh?: PublicMeshInfo,
    memberId?: string,
  ): Promise<void> {
    const networkId = this.networkIdFor(roomId, mesh);
    // Prefer the persisted node id so revocation survives a coordinator restart.
    const nodeId = memberId ?? this.memberIds.get(roomId)?.get(userId);
    this.memberIds.get(roomId)?.delete(userId);
    if (!networkId || !nodeId) return;
    await this.request(
      this.orgUrl(`/${encodeURIComponent(networkId)}/member/${encodeURIComponent(nodeId)}`),
      {
        method: "DELETE",
      },
    );
  }

  async teardown(roomId: string, mesh?: PublicMeshInfo): Promise<void> {
    const networkId = this.networkIdFor(roomId, mesh);
    this.memberIds.delete(roomId);
    if (!networkId) return;
    this.networks.delete(roomId);
    await this.request(this.orgUrl(`/${encodeURIComponent(networkId)}`), {
      method: "DELETE",
    });
  }
}
