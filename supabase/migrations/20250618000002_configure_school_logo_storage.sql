-- Configure public school logo storage used by Settings -> Branding.
-- This migration is idempotent and keeps uploads isolated to the authenticated
-- school administrator's own school ID.

INSERT INTO storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
VALUES (
  'school-logos',
  'school-logos',
  TRUE,
  5242880,
  ARRAY['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'Public can view school logos'
  ) THEN
    CREATE POLICY "Public can view school logos"
      ON storage.objects FOR SELECT
      USING (bucket_id = 'school-logos');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'School admins can upload their own logo'
  ) THEN
    CREATE POLICY "School admins can upload their own logo"
      ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (
        bucket_id = 'school-logos'
        AND EXISTS (
          SELECT 1
          FROM public.profiles
          WHERE profiles.id = auth.uid()
            AND profiles.role = 'school_admin'
            AND profiles.school_id::text = split_part(split_part(storage.objects.name, '/', 2), '.', 1)
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'School admins can update their own logo'
  ) THEN
    CREATE POLICY "School admins can update their own logo"
      ON storage.objects FOR UPDATE TO authenticated
      USING (
        bucket_id = 'school-logos'
        AND EXISTS (
          SELECT 1
          FROM public.profiles
          WHERE profiles.id = auth.uid()
            AND profiles.role = 'school_admin'
            AND profiles.school_id::text = split_part(split_part(storage.objects.name, '/', 2), '.', 1)
        )
      )
      WITH CHECK (
        bucket_id = 'school-logos'
        AND EXISTS (
          SELECT 1
          FROM public.profiles
          WHERE profiles.id = auth.uid()
            AND profiles.role = 'school_admin'
            AND profiles.school_id::text = split_part(split_part(storage.objects.name, '/', 2), '.', 1)
        )
      );
  END IF;
END
$$;
