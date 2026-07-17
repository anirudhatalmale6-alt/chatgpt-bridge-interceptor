<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Canonical schema for the memory vault.
 *
 * Deploy to: database/migrations/2026_07_17_000000_create_memories_table.php
 * Then:      php artisan migrate
 *
 * This is the SINGLE source of truth that both the store (write) and fetch
 * (read) paths agree on. The column names here are exactly what
 * ChatController, ApiMemoryController::store, and ApiMemoryController::fetch
 * all reference. If a `memories` table already exists with different columns,
 * do NOT run this blindly — reconcile first (see the notes in the chat).
 *
 * Uses createIfNotExists-style guards so it is safe to run on a fresh DB.
 */
return new class extends Migration
{
    public function up(): void
    {
        if (Schema::hasTable('memories')) {
            return; // table exists — reconcile manually, do not clobber
        }

        Schema::create('memories', function (Blueprint $table) {
            $table->id();

            // Tenant scope. Nullable so single-tenant bridge deployments work
            // without an auth layer. The store and fetch paths MUST use the
            // same resolved value (see ApiMemoryController::resolveAgentId).
            $table->string('agent_id')->nullable()->index();

            // Primary conversational scope used by the bridge.
            $table->string('session_id')->nullable()->index();

            // Optional cross-session grouping tag (fetch Mode A). Unused by the
            // bridge today but supported by the fetch endpoint.
            $table->string('context_tag')->nullable()->index();

            // Author of the memory. The bridge writes 'user'. Kept as `role`
            // to match what ChatController->storeMemory already sends.
            $table->string('role')->default('user');

            // The memory payload itself. longText so large notes never truncate.
            $table->longText('content');

            $table->timestamps();

            // Composite indexes for the two hot read paths.
            $table->index(['agent_id', 'session_id', 'created_at']);
            $table->index(['agent_id', 'context_tag', 'created_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('memories');
    }
};
