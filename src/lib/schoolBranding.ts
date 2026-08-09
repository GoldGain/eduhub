import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Last-resort report-card name requested for the Iiani deployment. In normal
 * operation every caller supplies the authenticated school's database name,
 * so other tenants continue to display their own branding.
 */
export const DEFAULT_REPORT_SCHOOL_NAME = 'IIANI SENIOR SCHOOL';

export interface SchoolBrandingInfo {
  id?: string;
  name: string;
  motto: string;
  logo_url: string | null;
  principal_name: string;
  principal_signature_url: string | null;
  principal_signature_type?: string | null;
  address: string;
  phone: string;
  email: string;
  website?: string;
  primary_color?: string;
  secondary_color?: string;
  status?: string | null;
  locked_reason?: string | null;
}

interface SchoolBrandingResult {
  data: SchoolBrandingInfo;
  found: boolean;
  error: unknown | null;
}

const FULL_BRANDING_COLUMNS = [
  'id',
  'name',
  'motto',
  'logo_url',
  'principal_name',
  'principal_signature_url',
  'principal_signature_type',
  'address',
  'phone',
  'email',
  'website',
  'primary_color',
  'secondary_color',
  'status',
  'locked_reason',
].join(', ');

// Keep progressively smaller selections so one optional column missing from an
// older database cannot hide the required school name and logo.
const BRANDING_COLUMN_ATTEMPTS = [
  FULL_BRANDING_COLUMNS,
  'id, name, logo_url, principal_name, principal_signature_url, address, phone, email, website, primary_color, secondary_color, status, locked_reason',
  'id, name, logo_url, address, phone, email',
  'id, name, logo_url',
  'id, name',
];

export function resolveSchoolName(
  name?: string | null,
  fallbackName: string = DEFAULT_REPORT_SCHOOL_NAME,
): string {
  return name?.trim() || fallbackName.trim() || DEFAULT_REPORT_SCHOOL_NAME;
}

export function isMissingColumnError(error: unknown, column?: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { code?: string; message?: string; details?: string };
  const message = `${record.message || ''} ${record.details || ''}`.toLowerCase();
  const referencesColumn = column ? message.includes(column.toLowerCase()) : true;
  return referencesColumn && (
    record.code === 'PGRST204' ||
    record.code === '42703' ||
    message.includes('schema cache') ||
    message.includes('column')
  );
}

function normaliseBranding(record: Record<string, unknown> | null, fallbackName: string): SchoolBrandingInfo {
  return {
    id: typeof record?.id === 'string' ? record.id : undefined,
    name: resolveSchoolName(record?.name as string | null | undefined, fallbackName),
    motto: typeof record?.motto === 'string' ? record.motto : '',
    logo_url: typeof record?.logo_url === 'string' && record.logo_url.trim() ? record.logo_url.trim() : null,
    principal_name: typeof record?.principal_name === 'string' ? record.principal_name : '',
    principal_signature_url: typeof record?.principal_signature_url === 'string' ? record.principal_signature_url : null,
    principal_signature_type: typeof record?.principal_signature_type === 'string' ? record.principal_signature_type : null,
    address: typeof record?.address === 'string' ? record.address : '',
    phone: typeof record?.phone === 'string' ? record.phone : '',
    email: typeof record?.email === 'string' ? record.email : '',
    website: typeof record?.website === 'string' ? record.website : '',
    primary_color: typeof record?.primary_color === 'string' ? record.primary_color : undefined,
    secondary_color: typeof record?.secondary_color === 'string' ? record.secondary_color : undefined,
    status: typeof record?.status === 'string' ? record.status : null,
    locked_reason: typeof record?.locked_reason === 'string' ? record.locked_reason : null,
  };
}

/**
 * Fetch school branding without allowing a missing optional database column to
 * collapse the whole result to a generic "School" label.
 */
export async function loadSchoolBranding(
  client: SupabaseClient,
  schoolId: string,
  fallbackName: string = DEFAULT_REPORT_SCHOOL_NAME,
): Promise<SchoolBrandingResult> {
  if (!schoolId) {
    return {
      data: normaliseBranding(null, fallbackName),
      found: false,
      error: new Error('A school ID is required to load branding.'),
    };
  }

  let lastError: unknown | null = null;

  for (const columns of BRANDING_COLUMN_ATTEMPTS) {
    const { data, error } = await client
      .from('schools')
      .select(columns)
      .eq('id', schoolId)
      .maybeSingle();

    if (!error && data) {
      return {
        data: normaliseBranding(data as unknown as Record<string, unknown>, fallbackName),
        found: true,
        error: null,
      };
    }

    if (error) lastError = error;
  }

  return {
    data: normaliseBranding(null, fallbackName),
    found: false,
    error: lastError || new Error('School branding was not found.'),
  };
}
