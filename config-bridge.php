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

];
