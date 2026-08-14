import postgres from "postgres"
import admin from "firebase-admin"

/**
 * ============================================================================
 * TYPES & INTERFACES
 * ============================================================================
 */

// Represents the exact payload sent by the Supabase Database Webhook
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
  content: string; // Represents the body/message
  notification_type?: string;
  project_id?: string;
  actor_id?: string;
  created_at: string;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// 1. Safely initialize the Firebase Admin singleton
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

// 2. Initialize Postgres Connection Pool
// Kept outside Deno.serve so the connection pool is reused across webhook triggers
const dbUrl = Deno.env.get('DATABASE_URL')
const sql = dbUrl ? postgres(dbUrl, { prepare: false }) : null;

/**
 * ============================================================================
 * MAIN FUNCTION HANDLER
 * ============================================================================
 */
Deno.serve(async (req: Request) => {
  // Handle CORS Preflight Requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // 1. Webhook Authentication via Custom Secret
    // Because Webhooks don't have user JWTs, we use a custom secret you set in the Dashboard.
    const authHeader = req.headers.get('Authorization')
    const webhookSecret = Deno.env.get('WEBHOOK_SECRET')
    
    if (!authHeader || authHeader !== `Bearer ${webhookSecret}`) {
      console.warn('Unauthorized execution attempt. Invalid or missing Authorization header.')
      return new Response(JSON.stringify({ error: "Unauthorized" }), { 
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 401 
      })
    }

    // 2. Parse and Validate Webhook Payload
    const payload: WebhookPayload = await req.json()
    const notification = payload.record 

    // Ignore anything that isn't a new insertion, or lacks a target user
    if (payload.type !== 'INSERT' || !notification?.profile_id) {
      return new Response(JSON.stringify({ message: "Ignored: Not a valid INSERT event or missing profile_id." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      })
    }

    if (!sql) throw new Error("DATABASE_URL is missing or invalid.")

    // 3. Direct PostgreSQL Query to fetch tokens
    const tokens = await sql<{ token: string }[]>`
      SELECT token 
      FROM fcm_tokens 
      WHERE profile_id = ${notification.profile_id}
    `

    if (!tokens || tokens.length === 0) {
      return new Response(JSON.stringify({ message: "Success: No active FCM tokens found for this user." }), { 
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200 
      })
    }

    const tokenArray = tokens.map((t) => t.token)

    // 4. Format the Routing Data Payload for Firebase
    const routingData: Record<string, string> = {
      notification_type: String(notification.notification_type || 'default'),
    }
    if (notification.project_id) routingData.project_id = String(notification.project_id)
    if (notification.actor_id) routingData.actor_id = String(notification.actor_id)

    // 5. Dispatch the Multicast Push Notification via Firebase
    const fcmResponse = await admin.messaging().sendEachForMulticast({
      tokens: tokenArray,
      notification: {
        title: notification.title,
        body: notification.content,
      },
      data: routingData,
    })

    // 6. Database Hygiene: Clean up dead/unregistered tokens using direct SQL
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
        try {
          // Native Postgres array binding for the IN / ANY clause
          await sql`DELETE FROM fcm_tokens WHERE token = ANY(${failedTokens})`
          console.log(`Database Hygiene: Cleaned up ${failedTokens.length} expired/invalid tokens.`)
        } catch (deleteError) {
          console.error('Failed to clean up dead tokens:', deleteError)
        }
      }
    }

    // 7. Return Successful Execution
    return new Response(JSON.stringify({ 
      success: true, 
      delivered: fcmResponse.successCount,
      failed: fcmResponse.failureCount
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    })

  } catch (error) {
    console.error('FCM Edge Function Error:', error)
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred in the Edge Function.'
    
    return new Response(JSON.stringify({ error: errorMessage }), { 
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500 
    })
  }
})