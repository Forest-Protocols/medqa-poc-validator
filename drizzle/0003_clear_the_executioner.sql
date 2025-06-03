CREATE TABLE "uploads" (
	"cid" varchar(100) PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"validator_id" integer NOT NULL,
	"commit_hash" varchar(70) NOT NULL,
	"uploaded_by" varchar(100) NOT NULL,
	"uploaded_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_validator_id_validators_id_fk" FOREIGN KEY ("validator_id") REFERENCES "public"."validators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_commit_hash_validations_commit_hash_fk" FOREIGN KEY ("commit_hash") REFERENCES "public"."validations"("commit_hash") ON DELETE no action ON UPDATE no action;