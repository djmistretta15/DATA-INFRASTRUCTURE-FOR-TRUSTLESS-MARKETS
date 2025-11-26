/**
 * Supabase client for authentication and data access.
 * TODO: Configure with real Supabase project credentials.
 */
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

// Export a function to create client (allows for server/client contexts)
export const createSupabaseClient = () => {
  if (!supabaseUrl || !supabaseAnonKey) {
    console.warn('Supabase credentials not configured. Using mock client.')
    // Return a mock client for development
    return null
  }

  return createClient(supabaseUrl, supabaseAnonKey)
}

// Default client for convenience
export const supabase = createSupabaseClient()
