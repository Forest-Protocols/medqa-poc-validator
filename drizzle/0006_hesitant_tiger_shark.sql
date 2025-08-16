ALTER TABLE "validations" ADD COLUMN "reveal_error" text;--> statement-breakpoint
ALTER TABLE "validations" ADD COLUMN "commit_error" text;--> statement-breakpoint

-- Update the new column with the old data
UPDATE "validations" SET "commit_error" = 'Vanished()' WHERE "is_vanished" = true;

ALTER TABLE "validations" DROP COLUMN "is_vanished";