import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MemoryFillipStore } from "./memory-store.js";
import type { Delivery, DigestSettings, OwnerContact, Reminder } from "./types.js";

type Snapshot = {
  reminders: Reminder[];
  deliveries: Delivery[];
  digests: DigestSettings[];
  contacts: OwnerContact[];
  providerBackoffUntil?: string | null;
};

/** Local schedule for one operator. Mail still requires a verified hosted account. */
export class FileFillipStore extends MemoryFillipStore {
  constructor(private filePath: string) {
    super();
    this.hydrate();
  }

  private hydrate() {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Snapshot;
      this.reminders = parsed.reminders ?? [];
      this.deliveries = parsed.deliveries ?? [];
      this.digests = new Map((parsed.digests ?? []).map((row) => [row.ownerId, row]));
      this.contacts = new Map((parsed.contacts ?? []).map((row) => [row.id, row]));
      this.providerBackoffUntil = parsed.providerBackoffUntil ?? null;
    } catch {
      this.reminders = [];
    }
  }

  private persist() {
    const snapshot: Snapshot = {
      reminders: this.reminders,
      deliveries: this.deliveries,
      digests: [...this.digests.values()],
      contacts: [...this.contacts.values()],
      providerBackoffUntil: this.providerBackoffUntil
    };
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(snapshot));
  }

  override async createReminder(reminder: Reminder): Promise<Reminder> {
    const saved = await super.createReminder(reminder);
    this.persist();
    return saved;
  }

  override async saveReminder(reminder: Reminder): Promise<Reminder> {
    const saved = await super.saveReminder(reminder);
    this.persist();
    return saved;
  }

  override async rememberOwner(contact: OwnerContact): Promise<void> {
    await super.rememberOwner(contact);
    this.persist();
  }

  override async setMailOptIn(ownerId: string, enabled: boolean): Promise<void> {
    await super.setMailOptIn(ownerId, enabled);
    this.persist();
  }

  override async saveDigest(settings: DigestSettings): Promise<void> {
    await super.saveDigest(settings);
    this.persist();
  }

  override async deleteOwnerData(ownerId: string): Promise<void> {
    await super.deleteOwnerData(ownerId);
    this.persist();
  }

  override async claimDelivery(input: Parameters<MemoryFillipStore["claimDelivery"]>[0]) {
    const result = await super.claimDelivery(input);
    this.persist();
    return result;
  }

  override async saveDelivery(delivery: Delivery): Promise<void> {
    await super.saveDelivery(delivery);
    this.persist();
  }

  override async saveUsage(ownerId: string, usage: { emailsSentInPeriod: number; emailPeriodStart: string }): Promise<void> {
    await super.saveUsage(ownerId, usage);
    this.persist();
  }

  override async setProviderBackoffUntil(untilIso: string): Promise<void> {
    await super.setProviderBackoffUntil(untilIso);
    this.persist();
  }
}
