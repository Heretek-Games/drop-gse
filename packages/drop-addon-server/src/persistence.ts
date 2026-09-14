import type { PluginStorage } from "@droposs/plugin-sdk";
import { parseCredential, parseRoom, tryParseRoom } from "./types.js";
import type { MeshCredential, Room } from "./types.js";

/**
 * Durable room/credential persistence. Two implementations exist:
 * `StorageRoomPersistence` (plugin storage; tests and dev) and
 * `PrismaRoomPersistence` (Drop's Postgres database; production default).
 */
export interface RoomPersistence {
  listRooms(): Promise<Room[]>;
  getRoom(id: string): Promise<Room | undefined>;
  saveRoom(room: Room): Promise<void>;
  deleteRoom(id: string): Promise<void>;
  /** Atomically delete a room and all of its credentials. */
  deleteRoomData(id: string): Promise<void>;
  getCredentials(roomId: string): Promise<Record<string, MeshCredential>>;
  /**
   * Persist a credential. Implementations store the assigned address/expiry but
   * redact `secret`, so backend secrets are not kept at rest; `RoomStore`
   * re-issues when it reads back an empty secret.
   */
  saveCredential(roomId: string, credential: MeshCredential): Promise<void>;
  deleteCredentials(roomId: string): Promise<void>;
  /** Delete credentials that expired at or before `before`. Returns the count. */
  deleteExpiredCredentials(before: number): Promise<number>;
}

const ROOMS_KEY = "rooms";
const CREDENTIALS_KEY = "credentials";

/** Plugin-storage persistence: two JSON blobs under the plugin's data dir. */
export class StorageRoomPersistence implements RoomPersistence {
  constructor(private readonly storage: PluginStorage) {}

  private async loadRooms(): Promise<Record<string, Room>> {
    return (await this.storage.get<Record<string, Room>>(ROOMS_KEY)) ?? {};
  }

  private async loadCredentials(): Promise<Record<string, Record<string, MeshCredential>>> {
    return (
      (await this.storage.get<Record<string, Record<string, MeshCredential>>>(CREDENTIALS_KEY)) ??
      {}
    );
  }

  async listRooms(): Promise<Room[]> {
    return Object.values(await this.loadRooms())
      .map(tryParseRoom)
      .filter((room): room is Room => room !== undefined);
  }

  async getRoom(id: string): Promise<Room | undefined> {
    const room = (await this.loadRooms())[id];
    return room ? parseRoom(room) : undefined;
  }

  async saveRoom(room: Room): Promise<void> {
    const rooms = await this.loadRooms();
    rooms[room.id] = room;
    await this.storage.set(ROOMS_KEY, rooms);
  }

  async deleteRoom(id: string): Promise<void> {
    const rooms = await this.loadRooms();
    Reflect.deleteProperty(rooms, id);
    await this.storage.set(ROOMS_KEY, rooms);
  }

  async deleteRoomData(id: string): Promise<void> {
    const rooms = await this.loadRooms();
    Reflect.deleteProperty(rooms, id);
    const credentials = await this.loadCredentials();
    Reflect.deleteProperty(credentials, id);
    await this.storage.set(ROOMS_KEY, rooms);
    await this.storage.set(CREDENTIALS_KEY, credentials);
  }

  async getCredentials(roomId: string): Promise<Record<string, MeshCredential>> {
    const perUser = (await this.loadCredentials())[roomId] ?? {};
    const result: Record<string, MeshCredential> = {};
    for (const [userId, credential] of Object.entries(perUser)) {
      result[userId] = parseCredential(credential);
    }
    return result;
  }

  async saveCredential(roomId: string, credential: MeshCredential): Promise<void> {
    const credentials = await this.loadCredentials();
    credentials[roomId] = credentials[roomId] ?? {};
    // Redact the secret at rest; the coordinator re-issues on demand.
    credentials[roomId][credential.userId] = {
      ...credential,
      secret: "",
    };
    await this.storage.set(CREDENTIALS_KEY, credentials);
  }

  async deleteCredentials(roomId: string): Promise<void> {
    const credentials = await this.loadCredentials();
    Reflect.deleteProperty(credentials, roomId);
    await this.storage.set(CREDENTIALS_KEY, credentials);
  }

  async deleteExpiredCredentials(before: number): Promise<number> {
    const credentials = await this.loadCredentials();
    let removed = 0;
    for (const roomId of Object.keys(credentials)) {
      const perUser = credentials[roomId];
      if (!perUser) continue;
      for (const userId of Object.keys(perUser)) {
        const credential = perUser[userId];
        if (credential && credential.expiresAt <= before) {
          Reflect.deleteProperty(perUser, userId);
          removed += 1;
        }
      }
      if (Object.keys(perUser).length === 0) {
        Reflect.deleteProperty(credentials, roomId);
      }
    }
    await this.storage.set(CREDENTIALS_KEY, credentials);
    return removed;
  }
}
