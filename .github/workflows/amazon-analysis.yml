name: Amazon AU Daily Analysis

on:
  schedule:
    - cron: '0 23 * * *'   # 9am Sydney
    - cron: '0 4 * * *'    # 2pm Sydney
    - cron: '0 10 * * *'   # 8pm Sydney
  workflow_dispatch:        # Manual trigger from GitHub UI
  repository_dispatch:      # Webhook — triggered by Power Automate when Stock list email arrives
    types: [stock-email-received]

env:
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true

jobs:
  analyze:
    runs-on: ubuntu-latest
    timeout-minutes: 60

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Install dependencies
        run: npm install

      - name: Run Amazon analysis
        env:
          AMAZON_CLIENT_ID: ${{ secrets.AMAZON_CLIENT_ID }}
          AMAZON_CLIENT_SECRET: ${{ secrets.AMAZON_CLIENT_SECRET }}
          AMAZON_REFRESH_TOKEN: ${{ secrets.AMAZON_REFRESH_TOKEN }}
          CLOUDFLARE_WORKER_URL: ${{ secrets.CLOUDFLARE_WORKER_URL }}
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}
          SHOPIFY_STORE_URL: ${{ secrets.SHOPIFY_STORE_URL }}
          SHOPIFY_ACCESS_TOKEN: ${{ secrets.SHOPIFY_ACCESS_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: node analyze.js

      - name: Report result
        if: always()
        run: echo "Analysis completed at $(date)"
