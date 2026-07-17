<?php

/**
 * Deploy to: /var/www/sites/mamory_vault/config/bridge.php
 *
 * Optional. Only used as a second-choice source for the identity block if
 * storage/app/identity_block.txt is missing or empty.
 *
 * Preferred source is the file — it can be edited without a redeploy or a
 * config:cache clear. Use this config only if you would rather keep the
 * identity in the deployment artifact.
 */

return [

    'identity_block' => env('BRIDGE_IDENTITY_BLOCK', ''),

    /*
     * Single-tenant fallback agent scope. Used by ApiMemoryController to scope
     * BOTH memory reads and writes when the X-Agent-Key middleware does not set
     * an 'agent_id' request attribute and there is no auth() session — which is
     * the case for the bridge's server-to-server calls.
     *
     * Reads and writes MUST resolve to the same value or they will silently
     * miss each other. Leave as-is for single-tenant. For multi-tenant, set the
     * agent_id in the middleware instead and set this to null to force scoping.
     */
    'default_agent_id' => env('BRIDGE_DEFAULT_AGENT_ID', 'bridge-user'),

];
