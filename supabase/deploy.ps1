<#
.SYNOPSIS
Interactive deployment pipeline for the 'case_notifications' Supabase Edge Function.
#>

$FUNCTION_NAME = "case_notifications"

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "CASE Deployment Pipeline: $FUNCTION_NAME" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan

Write-Host "`nSelect the environment you want to deploy to:" -ForegroundColor Cyan
Write-Host "1) Test Environment"
Write-Host "2) Production Environment"
Write-Host "3) Cancel"

$choice = Read-Host "`nEnter your choice (1-3)"

switch ($choice) {
    '1' {
        $PROJECT_REF = "krvyyaomycsiibnfrrsz"
        $ENV_FILE = "supabase/.env.test"
        $envName = "Test Environment"
    }
    '2' {
        $PROJECT_REF = "vitrawrvnevgdmjpycbe"
        $ENV_FILE = "supabase/.env.prod"
        $envName = "Production Environment"
    }
    '3' {
        Write-Host "Deployment cancelled." -ForegroundColor Yellow
        exit
    }
    default {
        Write-Host "Invalid option. Exiting." -ForegroundColor Red
        exit
    }
}

# 1. Ensure environment file exists
if (-Not (Test-Path $ENV_FILE)) {
    Write-Host "`nERROR: Cannot find $ENV_FILE" -ForegroundColor Red
    Write-Host "Please ensure your environment files are created inside the 'supabase/' folder." -ForegroundColor Yellow
    exit 1
}

# 2. Sync secrets to Supabase Vault
Write-Host "`nSetting secrets from $ENV_FILE for $envName..." -ForegroundColor Green
supabase secrets set --env-file $ENV_FILE --project-ref $PROJECT_REF

if ($LASTEXITCODE -ne 0) {
    Write-Host "`nFailed to upload secrets. Deployment aborted." -ForegroundColor Red
    exit 1
}

# 3. Deploy Edge Function
Write-Host "`nDeploying $FUNCTION_NAME to $envName..." -ForegroundColor Green
supabase functions deploy $FUNCTION_NAME --no-verify-jwt --import-map supabase/functions/deno.json --project-ref $PROJECT_REF

if ($LASTEXITCODE -eq 0) {
    Write-Host "`nDeployment to $envName complete!" -ForegroundColor Cyan
    Write-Host "Your database webhook will now seamlessly authenticate using your WEBHOOK_SECRET." -ForegroundColor Yellow
} else {
    Write-Host "`nDeployment failed. Check the CLI logs above for details." -ForegroundColor Red
}