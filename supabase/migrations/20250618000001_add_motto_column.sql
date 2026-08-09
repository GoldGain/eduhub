-- Migration: Add motto column to schools table
-- This fixes the "Could not find the 'motto' column of 'schools' in the schema cache" error

ALTER TABLE public.schools ADD COLUMN IF NOT EXISTS motto TEXT;

-- Ask PostgREST to refresh immediately so Branding does not continue seeing a
-- stale schema cache after the migration has completed.
NOTIFY pgrst, 'reload schema';
