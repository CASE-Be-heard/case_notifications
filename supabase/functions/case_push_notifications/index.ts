import { createClient } from "@supabase/supabase-js"
import admin from "firebase-admin"

/**
 * ============================================================================
 * TYPES & INTERFACES
 * ============================================================================
 */

// Represents the payload sent by the Supabase Database Webhook
interface WebhookPayload {
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  table: string;
  record: NotificationRecord;
  schema: string;
  old_record: null | NotificationRecord;
}

// Represents the structure of a row in your 'notifications' table
interface NotificationRecord {
  id: string;
  profile_id: string; // The target user receiving the push
  title: string;
  content: string;
  notification_type?: string;
  project_id?: string;
  actor_id?: string;
  created_at: string;
}

/**
 * ============================================================================
 * INITIALIZATION & SETUP
 * ============================================================================
 */

// 1. Standard CORS headers for Deno Edge Functions
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// 2. Safely initialize the Firebase Admin singleton.
// We do this outside the Deno.serve block so it only runs once per cold start,
// preventing memory leaks or duplicate app crashes.
const serviceAccountEnv = Deno.env.get('FIREBASE_SERVICE_ACCOUNT')
if (!serviceAccountEnv) {
  console.error('FATAL: FIREBASE_SERVICE_ACCOUNT environment variable is missing.')
} else if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(serviceAccountEnv)
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    })
    console.log('Firebase Admin SDK initialized successfully.')
  } catch (error) {
    console.error('FATAL: Failed to parse Firebase service account JSON:', error)
  }
}

/**
 * ============================================================================
 * MAIN FUNCTION HANDLER
 * ============================================================================
 */
Deno.serve(async (req: Request) => {
  // 1. Handle CORS Preflight Requests from browsers/apps
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // 2. Webhook Authentication (CRUCIAL SECURITY STEP)
    // Because this endpoint is public, we must verify it was triggered by YOUR database.
    const authHeader = req.headers.get('Authorization')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    
    if (!authHeader || authHeader !== `Bearer ${serviceRoleKey}`) {
      console.warn('Unauthorized execution attempt. Invalid or missing Authorization header.')
      return new Response(JSON.stringify({ error: "Unauthorized" }), { 
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 401 
      })
    }

    // 3. Parse and Validate the Webhook Payload
    const payload: WebhookPayload = await req.json()
    const notification = payload.record 

    // Exit cleanly if this isn't an insertion or lacks a target user. 
    // Returning 200 ensures the Supabase webhook doesn't mark it as a "failed" delivery.
    if (payload.type !== 'INSERT' || !notification?.profile_id) {
      return new Response(JSON.stringify({ message: "Ignored: Not a valid INSERT event or missing profile_id." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      })
    }

    // 4. Initialize Supabase Client
    // We use the Service Role Key here to deliberately bypass Row Level Security (RLS)
    // so the server can securely query the private fcm_tokens table.
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    if (!supabaseUrl || !serviceRoleKey) throw new Error("Missing Supabase environment variables.")
    
    const supabase = createClient(supabaseUrl, serviceRoleKey)

    // 5. Fetch Target Device Tokens
    // A single user might have your app installed on both a phone and a tablet.
    const { data: tokens, error: dbError } = await supabase
      .from('fcm_tokens')
      .select('token')
      .eq('profile_id', notification.profile_id)

    if (dbError) throw new Error(`Database error fetching tokens: ${dbError.message}`)

    if (!tokens || tokens.length === 0) {
      return new Response(JSON.stringify({ message: "Success: No active FCM tokens found for this user." }), { 
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200 
      })
    }

    const tokenArray = tokens.map((t) => t.token)

    // 6. Format the Routing Data Payload
    // FCM strictly requires all custom `data` properties to be strings. 
    // Passing integers or nulls here will cause Firebase to throw a silent error.
    const routingData: Record<string, string> = {
      notification_type: String(notification.notification_type || 'default'),
    }
    if (notification.project_id) routingData.project_id = String(notification.project_id)
    if (notification.actor_id) routingData.actor_id = String(notification.actor_id)

    // 7. Dispatch the Multicast Push Notification via Firebase
    const fcmResponse = await admin.messaging().sendEachForMulticast({
      tokens: tokenArray,
      notification: {
        title: notification.title,
        body: notification.content,
      },
      data: routingData,
    })

    // 8. Database Hygiene: Clean up dead/unregistered tokens
    // If a user uninstalls the app or revokes permissions, Firebase tells us here.
    // We actively delete dead tokens to save database space and optimize future broadcasts.
    if (fcmResponse.failureCount > 0) {
      const failedTokens: string[] = []
      
      fcmResponse.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const code = resp.error?.code
          if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
            failedTokens.push(tokenArray[idx])
          }
        }
      })

      if (failedTokens.length > 0) {
        const { error: deleteError } = await supabase
          .from('fcm_tokens')
          .delete()
          .in('token', failedTokens)
          
        if (deleteError) {
          console.error('Failed to clean up dead tokens:', deleteError)
        } else {
          console.log(`Database Hygiene: Cleaned up ${failedTokens.length} expired/invalid tokens.`)
        }
      }
    }

    // 9. Return Successful Execution
    return new Response(JSON.stringify({ 
      success: true, 
      delivered: fcmResponse.successCount,
      failed: fcmResponse.failureCount
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    })

  } catch (error) {
    // 10. Global Error Handler
    console.error('FCM Edge Function Error:', error)
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred in the Edge Function.'
    
    return new Response(JSON.stringify({ error: errorMessage }), { 
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500 
    })
  }
})