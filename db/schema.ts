import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// A user's simulation is one aggregate. A conditional lease plus revision check
// serializes agent turns, feedback, and memory edits across Worker instances.
export const palaceStates = sqliteTable("palace_states", {
  userId: text("user_id").primaryKey(),
  stateJson: text("state_json").notNull(),
  version: integer("version").notNull().default(0),
  leaseToken: text("lease_token"),
  leaseUntil: integer("lease_until").notNull().default(0),
  requestIdsJson: text("request_ids_json").notNull().default("[]"),
  updatedAt: text("updated_at").notNull(),
});

export const providerSettings = sqliteTable("provider_settings", {
  userId: text("user_id").notNull(),
  kind: text("kind", { enum: ["text", "image"] }).notNull(),
  baseUrl: text("base_url").notNull(),
  model: text("model").notNull(),
  imageOptions: text("image_options"),
  connectionOptions: text("connection_options"),
  encryptedApiKey: text("encrypted_api_key").notNull(),
  updatedAt: text("updated_at").notNull(),
}, table => [primaryKey({ columns: [table.userId, table.kind] })]);
