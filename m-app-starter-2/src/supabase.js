import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();

// Publishable keys belong in browser apps. Secret/service-role keys never do.
if (key?.startsWith('sb_secret_')) throw new Error('Use the Supabase publishable key, not a secret key.');
export const supabase = url && key ? createClient(url, key) : null;
