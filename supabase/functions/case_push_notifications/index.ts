import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import admin from "npm:firebase-admin@11.11.0"

// 1. Standard CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// 2. Safely Initialize Firebase Admin
const serviceAccountEnv = Deno.env.get('FIREBASE_SERVICE_ACCOUNT')
if (!serviceAccountEnv) {
  console.error('FATAL: FIREBASE_SERVICE_ACCOUNT environment variable is missing.')
} else if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(serviceAccountEnv)
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    })
  } catch (error) {
    console.error('FATAL: Failed to parse Firebase service account JSON:', error)
  }
}

// 3. Use modern Deno.serve (no import required)
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // SECURITY CHECK: Verify the request came from your Supabase Webhook
    const authHeader = req.headers.get('Authorization')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    
    if (!authHeader || authHeader !== `Bearer ${serviceRoleKey}`) {
      console.warn('Unauthorized attempt to trigger push notification.')
      return new Response(JSON.stringify({ error: "Unauthorized" }), { 
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 401 
      })
    }

    const payload = await req.json()
    const notification = payload.record 

    if (payload.type !== 'INSERT' || !notification?.profile_id) {
      return new Response(JSON.stringify({ message: "Ignored: Not a valid INSERT event" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      })
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      serviceRoleKey ?? ''
    )

    const { data: tokens, error } = await supabase
      .from('fcm_tokens')
      .select('token')
      .eq('profile_id', notification.profile_id)

    if (error || !tokens || tokens.length === 0) {
      return new Response(JSON.stringify({ message: "No FCM tokens found for user" }), { 
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200 
      })
    }

    const tokenArray = tokens.map((t) => t.token)

    // Construct the data payload ensuring everything is strictly a string
    const routingData: Record<string, string> = {
      notification_type: String(notification.notification_type || ''),
    }
    if (notification.project_id) routingData.project_id = String(notification.project_id)
    if (notification.actor_id) routingData.actor_id = String(notification.actor_id)

    const fcmResponse = await admin.messaging().sendEachForMulticast({
      tokens: tokenArray,
      notification: {
        title: notification.title,
        body: notification.content,
      },
      data: routingData,
    })

    // Enhanced Cleanup: Handle both invalid and unregistered tokens
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
        await supabase.from('fcm_tokens').delete().in('token', failedTokens)
        console.log(`Cleaned up ${failedTokens.length} expired/invalid tokens.`)
      }
    }

    return new Response(JSON.stringify({ success: true, fcmResponse }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    })

  } catch (error) {
    console.error('Edge Function Error:', error)
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred'
    
    return new Response(JSON.stringify({ error: errorMessage }), { 
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500 
    })
  }
})