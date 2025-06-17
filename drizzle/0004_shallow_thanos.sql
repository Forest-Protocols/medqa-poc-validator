ALTER TABLE "test_results" DROP CONSTRAINT "test_results_session_id_validations_session_id_fk";
--> statement-breakpoint
ALTER TABLE "uploads" DROP CONSTRAINT "uploads_validator_id_validators_id_fk";
--> statement-breakpoint
ALTER TABLE "validations" DROP CONSTRAINT "validations_validator_id_validators_id_fk";
--> statement-breakpoint
ALTER TABLE "test_results" ADD CONSTRAINT "test_results_session_id_validations_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."validations"("session_id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_validator_id_validators_id_fk" FOREIGN KEY ("validator_id") REFERENCES "public"."validators"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "validations" ADD CONSTRAINT "validations_validator_id_validators_id_fk" FOREIGN KEY ("validator_id") REFERENCES "public"."validators"("id") ON DELETE cascade ON UPDATE cascade;