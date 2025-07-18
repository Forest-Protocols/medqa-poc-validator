import { StructuredTestResults } from "@/core/types";
import { relations } from "drizzle-orm";
import {
  boolean,
  integer,
  json,
  pgTable,
  smallint,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { Hex } from "viem";

export const testResultsTable = pgTable("test_results", {
  id: integer().primaryKey().generatedByDefaultAsIdentity(),
  sessionId: varchar("session_id", { length: 15 })
    .references(() => validationsTable.sessionId, {
      onDelete: "cascade",
      onUpdate: "cascade",
    })
    .notNull(),
  isSuccess: boolean("is_success").notNull().default(true),
  raw: text().notNull().default(""),
  result: json().notNull().$type<StructuredTestResults>().default({}),
  testName: varchar("test_name", { length: 100 }).notNull().default("N/A"),
});
relations(testResultsTable, ({ one }) => ({
  validation: one(validationsTable, {
    fields: [testResultsTable.sessionId],
    references: [validationsTable.sessionId],
  }),
}));

export const validationsTable = pgTable("validations", {
  sessionId: varchar("session_id", { length: 15 }).primaryKey(),
  validatorId: integer("validator_id")
    .references(() => validatorsTable.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    })
    .notNull(),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  finishedAt: timestamp("finished_at").notNull().defaultNow(),
  score: smallint().notNull().default(0),
  agreementId: integer("agreement_id").notNull(),
  offerId: integer("offer_id").notNull(),
  providerId: integer("provider_id").notNull(),
  commitHash: varchar("commit_hash", { length: 70 }).$type<Hex>(),
  isRevealed: boolean("is_revealed").notNull().default(false),
  isVanished: boolean("is_vanished").notNull().default(false),
});
relations(validationsTable, ({ many, one }) => ({
  testResults: many(testResultsTable),
  validator: one(validatorsTable, {
    fields: [validationsTable.validatorId],
    references: [validatorsTable.id],
  }),
}));

export const uploadsTable = pgTable("uploads", {
  cid: varchar({ length: 100 }).primaryKey(),
  content: text().notNull(),
  validatorId: integer("validator_id")
    .references(() => validatorsTable.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    })
    .notNull(),
  commitHash: varchar("commit_hash", { length: 70 }).$type<Hex>().notNull(),
  uploadedBy: varchar("uploaded_by", { length: 100 }).notNull(),
  uploadedAt: timestamp("uploaded_at"),
});

export const validatorsTable = pgTable("validators", {
  id: integer("id").primaryKey(),
  ownerAddress: varchar("owner_address", { length: 65 }).notNull().unique(),
});
relations(validatorsTable, ({ many }) => ({
  validations: many(validationsTable),
}));

export const detailFilesTable = pgTable("detail_files", {
  id: integer().primaryKey().generatedByDefaultAsIdentity(),
  cid: varchar({ length: 100 }).notNull().unique(),
  content: text().notNull(),
});

export type DbDetailFileInsert = typeof detailFilesTable.$inferInsert;
export type DbValidationInsert = typeof validationsTable.$inferInsert;
export type DbValidation = typeof validationsTable.$inferSelect;
