-- Phase 3: Pre-sales — inquiries, assignment, follow-ups, communication
-- Run as the DB owner role (superuser / table creator).

-- ============================================================
-- 1. Enums
-- ============================================================

CREATE TYPE "InquiryStatus" AS ENUM ('OPEN', 'CONTINUED', 'DUMPED', 'SUCCESSFUL');
CREATE TYPE "FollowUpOutcome" AS ENUM ('COMPLETED', 'NO_RESPONSE', 'RESCHEDULED', 'NOT_INTERESTED', 'CONVERTED');
CREATE TYPE "CommunicationChannel" AS ENUM ('EMAIL', 'SMS');
CREATE TYPE "CommunicationStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

-- ============================================================
-- 2. Tables
-- ============================================================

-- CreateTable
CREATE TABLE "applicants" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "primary_phone" VARCHAR(20) NOT NULL,
    "primary_phone_normalized" VARCHAR(20) NOT NULL,
    "alternate_phones" TEXT[],
    "email" VARCHAR(255),
    "email_normalized" VARCHAR(255),
    "address_line1" VARCHAR(255),
    "city" VARCHAR(100),
    "state" VARCHAR(100),
    "pincode" VARCHAR(10),
    "custom_fields" JSONB,
    "merged_into_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "applicants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applicant_consents" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "applicant_id" UUID NOT NULL,
    "given" BOOLEAN NOT NULL,
    "source" VARCHAR(100),
    "actor_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "applicant_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applicant_merges" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "survivor_id" UUID NOT NULL,
    "merged_id" UUID NOT NULL,
    "merged_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "applicant_merges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inquiry_temperatures" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inquiry_temperatures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inquiries" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "applicant_id" UUID NOT NULL,
    "project_id" UUID,
    "source_id" UUID,
    "inquiry_type_id" UUID,
    "budget_min_paise" BIGINT,
    "budget_max_paise" BIGINT,
    "preferred_unit_type_id" UUID,
    "temperature_id" UUID,
    "assigned_to_id" UUID,
    "status" "InquiryStatus" NOT NULL DEFAULT 'OPEN',
    "next_followup_at" TIMESTAMP(3),
    "last_escalated_at" TIMESTAMP(3),
    "custom_fields" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inquiries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inquiry_assignments" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "inquiry_id" UUID NOT NULL,
    "from_user_id" UUID,
    "to_user_id" UUID NOT NULL,
    "assignment_type" VARCHAR(20) NOT NULL,
    "actor_id" UUID,
    "reason" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inquiry_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_assignment_pools" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "paused_reason" VARCHAR(100),
    "last_assigned_at" TIMESTAMP(6),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_assignment_pools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "follow_ups" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "inquiry_id" UUID NOT NULL,
    "follow_up_type_id" UUID,
    "notes" TEXT,
    "outcome" "FollowUpOutcome",
    "next_action_at" TIMESTAMP(3),
    "scheduled_at" TIMESTAMP(3),
    "venue" VARCHAR(255),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "follow_ups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_templates" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "dlt_template_id" VARCHAR(50) NOT NULL,
    "sender_id" VARCHAR(11) NOT NULL,
    "header_id" VARCHAR(50),
    "body" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sms_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "communication_logs" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "inquiry_id" UUID,
    "applicant_id" UUID NOT NULL,
    "channel" "CommunicationChannel" NOT NULL,
    "to_address" VARCHAR(255) NOT NULL,
    "subject" VARCHAR(500),
    "body" TEXT NOT NULL,
    "status" "CommunicationStatus" NOT NULL DEFAULT 'QUEUED',
    "provider_message_id" VARCHAR(255),
    "error_message" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "communication_logs_pkey" PRIMARY KEY ("id")
);

-- ============================================================
-- 3. Indexes
-- ============================================================

CREATE INDEX "applicants_company_id_primary_phone_normalized_idx" ON "applicants"("company_id", "primary_phone_normalized");
CREATE INDEX "applicants_company_id_email_normalized_idx" ON "applicants"("company_id", "email_normalized");
CREATE INDEX "applicant_consents_applicant_id_created_at_idx" ON "applicant_consents"("applicant_id", "created_at");
CREATE UNIQUE INDEX "applicant_merges_merged_id_key" ON "applicant_merges"("merged_id");
CREATE UNIQUE INDEX "inquiry_temperatures_company_id_name_key" ON "inquiry_temperatures"("company_id", "name");
CREATE INDEX "inquiries_company_id_assigned_to_id_status_idx" ON "inquiries"("company_id", "assigned_to_id", "status");
CREATE INDEX "inquiries_company_id_next_followup_at_idx" ON "inquiries"("company_id", "next_followup_at");
CREATE INDEX "inquiries_company_id_status_created_at_idx" ON "inquiries"("company_id", "status", "created_at");
CREATE INDEX "inquiry_assignments_inquiry_id_created_at_idx" ON "inquiry_assignments"("inquiry_id", "created_at");
CREATE INDEX "project_assignment_pools_company_id_project_id_is_active_idx" ON "project_assignment_pools"("company_id", "project_id", "is_active");
CREATE UNIQUE INDEX "project_assignment_pools_project_id_user_id_key" ON "project_assignment_pools"("project_id", "user_id");
CREATE INDEX "follow_ups_company_id_inquiry_id_created_at_idx" ON "follow_ups"("company_id", "inquiry_id", "created_at");
CREATE INDEX "follow_ups_company_id_next_action_at_idx" ON "follow_ups"("company_id", "next_action_at");
CREATE UNIQUE INDEX "sms_templates_company_id_name_key" ON "sms_templates"("company_id", "name");
CREATE INDEX "communication_logs_company_id_applicant_id_created_at_idx" ON "communication_logs"("company_id", "applicant_id", "created_at");

-- ============================================================
-- 4. Foreign keys
-- ============================================================

ALTER TABLE "applicants" ADD CONSTRAINT "applicants_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "applicants" ADD CONSTRAINT "applicants_merged_into_id_fkey" FOREIGN KEY ("merged_into_id") REFERENCES "applicants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "applicant_consents" ADD CONSTRAINT "applicant_consents_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "applicant_consents" ADD CONSTRAINT "applicant_consents_applicant_id_fkey" FOREIGN KEY ("applicant_id") REFERENCES "applicants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "applicant_consents" ADD CONSTRAINT "applicant_consents_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "applicant_merges" ADD CONSTRAINT "applicant_merges_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "applicant_merges" ADD CONSTRAINT "applicant_merges_survivor_id_fkey" FOREIGN KEY ("survivor_id") REFERENCES "applicants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "applicant_merges" ADD CONSTRAINT "applicant_merges_merged_id_fkey" FOREIGN KEY ("merged_id") REFERENCES "applicants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "applicant_merges" ADD CONSTRAINT "applicant_merges_merged_by_id_fkey" FOREIGN KEY ("merged_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "inquiry_temperatures" ADD CONSTRAINT "inquiry_temperatures_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_applicant_id_fkey" FOREIGN KEY ("applicant_id") REFERENCES "applicants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "inquiry_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_inquiry_type_id_fkey" FOREIGN KEY ("inquiry_type_id") REFERENCES "inquiry_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_preferred_unit_type_id_fkey" FOREIGN KEY ("preferred_unit_type_id") REFERENCES "unit_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_temperature_id_fkey" FOREIGN KEY ("temperature_id") REFERENCES "inquiry_temperatures"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "inquiry_assignments" ADD CONSTRAINT "inquiry_assignments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inquiry_assignments" ADD CONSTRAINT "inquiry_assignments_inquiry_id_fkey" FOREIGN KEY ("inquiry_id") REFERENCES "inquiries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "inquiry_assignments" ADD CONSTRAINT "inquiry_assignments_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "inquiry_assignments" ADD CONSTRAINT "inquiry_assignments_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inquiry_assignments" ADD CONSTRAINT "inquiry_assignments_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "project_assignment_pools" ADD CONSTRAINT "project_assignment_pools_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_assignment_pools" ADD CONSTRAINT "project_assignment_pools_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_assignment_pools" ADD CONSTRAINT "project_assignment_pools_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_inquiry_id_fkey" FOREIGN KEY ("inquiry_id") REFERENCES "inquiries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_follow_up_type_id_fkey" FOREIGN KEY ("follow_up_type_id") REFERENCES "follow_up_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "sms_templates" ADD CONSTRAINT "sms_templates_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "communication_logs" ADD CONSTRAINT "communication_logs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "communication_logs" ADD CONSTRAINT "communication_logs_inquiry_id_fkey" FOREIGN KEY ("inquiry_id") REFERENCES "inquiries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "communication_logs" ADD CONSTRAINT "communication_logs_applicant_id_fkey" FOREIGN KEY ("applicant_id") REFERENCES "applicants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "communication_logs" ADD CONSTRAINT "communication_logs_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
-- 5. Row-Level Security for Phase 3 tables
-- ============================================================

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY[
      'applicants', 'applicant_consents', 'applicant_merges',
      'inquiry_temperatures', 'inquiries', 'inquiry_assignments',
      'project_assignment_pools', 'follow_ups', 'sms_templates',
      'communication_logs'
    ])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation_policy ON %I
         FOR ALL
         USING (company_id = current_setting(''app.current_company_id'', true)::uuid)
         WITH CHECK (company_id = current_setting(''app.current_company_id'', true)::uuid)',
      tbl
    );
  END LOOP;
END
$$;
