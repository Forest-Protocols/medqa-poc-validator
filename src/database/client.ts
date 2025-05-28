import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { config } from "@/core/config";
import { generateCID } from "@forest-protocols/sdk";
import {
  and,
  eq,
  getTableColumns,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { logger } from "@/core/logger";
import * as schema from "./schema";
import pg from "pg";
import { Address, Hex } from "viem";
import { TestResult } from "@/core/types";

export type DatabaseClientType = NodePgDatabase<typeof schema>;

/**
 * Interact with the database that stores local state of the daemon
 */
class DatabaseClient {
  private pool: pg.Pool;
  client: DatabaseClientType;
  logger = logger.child({ context: "Database" });

  constructor() {
    this.pool = new pg.Pool({
      connectionString: config.DATABASE_URL,
    });

    this.client = drizzle(this.pool, {
      schema,
    });
  }

  async disconnect() {
    if (this.pool.ended) {
      return;
    }
    await this.pool.end(() => this.logger.info("Database connection closed"));
  }

  async getDetailFiles(cids: string[]) {
    return await this.client
      .select()
      .from(schema.detailFilesTable)
      .where(or(...cids.map((cid) => eq(schema.detailFilesTable.cid, cid))));
  }

  /**
   * Gets all the validations that are not committed to the blockchain yet.
   */
  async getUncommittedValidations(validatorId: number) {
    return await this.client
      .select({
        ...getTableColumns(schema.validationsTable),
        testResults: this.testResultsAggregation,
      })
      .from(schema.validationsTable)
      .innerJoin(
        schema.testResultsTable,
        eq(schema.testResultsTable.sessionId, schema.validationsTable.sessionId)
      )
      .where(
        and(
          isNull(schema.validationsTable.commitHash),
          eq(schema.validationsTable.validatorId, validatorId),
          eq(schema.validationsTable.isVanished, false),
          eq(schema.validationsTable.isRevealed, false)
        )
      )
      .groupBy(schema.validationsTable.sessionId);
  }

  /**
   * Gets all the validations that are not revealed yet.
   * Only gets the ones that already committed to the blockchain.
   */
  async getUnrevealedValidations(validatorId: number) {
    return await this.client
      .select({
        ...getTableColumns(schema.validationsTable),
        testResults: this.testResultsAggregation,
      })
      .from(schema.validationsTable)
      .innerJoin(
        schema.testResultsTable,
        eq(schema.testResultsTable.sessionId, schema.validationsTable.sessionId)
      )
      .where(
        and(
          isNotNull(schema.validationsTable.commitHash),
          eq(schema.validationsTable.isRevealed, false),
          eq(schema.validationsTable.isVanished, false),
          eq(schema.validationsTable.validatorId, validatorId)
        )
      )
      .groupBy(schema.validationsTable.sessionId);
  }

  async setCommitHash(sessionIds: string[], hash: Hex) {
    await this.client
      .update(schema.validationsTable)
      .set({
        commitHash: hash,
      })
      .where(
        or(
          ...sessionIds.map((sessionId) =>
            eq(schema.validationsTable.sessionId, sessionId)
          )
        )
      );
  }

  /**
   * Saves or updates a Validator to the database
   */
  async upsertValidator(
    id: number,
    detailsLink: string,
    ownerAddress: Address
  ) {
    ownerAddress = ownerAddress.toLowerCase() as Address;
    return await this.client.transaction(async (tx) => {
      const [existingValidator] = await tx
        .select()
        .from(schema.validatorsTable)
        .where(
          and(
            eq(schema.validatorsTable.ownerAddress, ownerAddress),
            eq(schema.validatorsTable.id, id)
          )
        );

      const [detailsFile] = await tx
        .select()
        .from(schema.detailFilesTable)
        .where(eq(schema.detailFilesTable.cid, detailsLink));

      if (detailsFile === undefined) {
        throw new Error(
          `Details file not found for Validator ${id}. Please be sure you've placed the details of into "data/details/[filename].json"`
        );
      }

      let validator = existingValidator;

      if (existingValidator !== undefined) {
        // TODO: Update Validator
      } else {
        [validator] = await tx
          .insert(schema.validatorsTable)
          .values({
            id,
            ownerAddress: ownerAddress,
          })
          .returning();
      }

      return { validator, detailsFile: detailsFile.content };
    });
  }

  async markAsRevealed(commitHash: Hex) {
    await this.client
      .update(schema.validationsTable)
      .set({
        isRevealed: true,
      })
      .where(
        and(
          eq(schema.validationsTable.isRevealed, false),
          eq(schema.validationsTable.commitHash, commitHash)
        )
      )
      .returning();
  }

  async markAsVanished(commitHash: Hex) {
    await this.client
      .update(schema.validationsTable)
      .set({
        isVanished: true,
      })
      .where(
        and(
          eq(schema.validationsTable.isVanished, false),
          eq(schema.validationsTable.commitHash, commitHash)
        )
      )
      .returning();
  }

  /**
   * Saves a validation with test results to the database
   */
  async saveValidation(
    validation: schema.DbValidationInsert,
    testResults: TestResult[]
  ) {
    await this.client.transaction(async (tx) => {
      // Insert validation
      await tx.insert(schema.validationsTable).values(validation);

      // Insert test results
      await tx.insert(schema.testResultsTable).values(
        testResults.map((testResult) => ({
          sessionId: validation.sessionId,
          ...testResult,
        }))
      );
    });
  }

  /**
   * Saves the given contents to the database as detail files.
   */
  async saveDetailFiles(contents: string[]) {
    const values: schema.DbDetailFileInsert[] = [];

    for (const content of contents) {
      const cid = await generateCID(content);
      values.push({
        cid: cid.toString(),
        content: content,
      });
    }

    await this.client.transaction(async (tx) => {
      // Clear out all of the detail files that currently we have
      await tx.delete(schema.detailFilesTable);

      // Then save the new ones.
      await tx
        .insert(schema.detailFilesTable)
        .values(values)
        .onConflictDoNothing();
    });
  }

  private get testResultsAggregation() {
    return sql<TestResult[]>`
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'isSuccess', ${schema.testResultsTable.isSucceed},
            'raw', ${schema.testResultsTable.raw},
            'result', ${schema.testResultsTable.result},
            'testName', ${schema.testResultsTable.testName}
          )
        )
        FILTER(
          WHERE ${isNotNull(schema.testResultsTable.sessionId)}
        ),
        '[]'::jsonb
      )`;
  }
}

export const DB = new DatabaseClient();
