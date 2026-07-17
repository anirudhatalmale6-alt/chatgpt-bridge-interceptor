<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Log;
use Carbon\Carbon;
use App\Models\Memory;

/**
 * ApiMemoryController — adapted from the hardened candidate.
 *
 * Deploy to: app/Http/Controllers/ApiMemoryController.php
 *
 * Routes (routes/api.php), behind the X-Agent-Key middleware:
 *   Route::get ('/agent-memory',        [ApiMemoryController::class, 'fetch']);
 *   Route::post('/agent-memory/store',  [ApiMemoryController::class, 'store']);
 *
 * WHAT CHANGED vs the candidate, and WHY (all bridge-driven):
 *   1. resolveAgentId(): the bridge calls this endpoint server-to-server with a
 *      shared X-Agent-Key. There is no Laravel auth() session on that call, so
 *      the candidate's `auth()->id()` was always null and every bridge read
 *      would 401. Now falls back to the middleware attribute, then auth, then a
 *      configurable single-tenant default — so the bridge never hard-401s.
 *      CRUCIALLY store() and fetch() share this helper, so writes and reads are
 *      always scoped to the SAME agent_id and cannot silently miss each other.
 *   2. Column is `role`, not `source`. The bridge (ChatController->storeMemory)
 *      writes `role`. The candidate read `source`, which would have returned
 *      every memory as the 'system' default. Aligned to `role`, with a
 *      source-column fallback for legacy rows.
 *   3. Honors the `limit` query param the bridge sends (default 20, hard cap
 *      100). The candidate hardcoded 100, which would bloat the injected
 *      [MEMORY] block and eat ChatGPT context budget.
 *   4. store() added here so write + read share one schema and one agent scope.
 *      This is the fix for the /api/agent-memory/store 500.
 */
class ApiMemoryController extends Controller
{
    /** Hard ceiling on rows returned, regardless of requested limit. */
    private const MAX_LIMIT     = 100;
    private const DEFAULT_LIMIT = 20;

    // ==================================================================
    //  READ  — GET /api/agent-memory
    // ==================================================================
    public function fetch(Request $request)
    {
        $request->validate([
            'session_id'  => ['required_without:context_tag', 'string', 'nullable'],
            'context_tag' => ['required_without:session_id', 'string', 'nullable'],
            'limit'       => ['sometimes', 'integer', 'min:1'],
        ]);

        $sessionId  = $request->input('session_id');
        $contextTag = $request->input('context_tag');
        $limit      = min((int) $request->input('limit', self::DEFAULT_LIMIT), self::MAX_LIMIT);
        if ($limit < 1) $limit = self::DEFAULT_LIMIT;

        $agentId = $this->resolveAgentId($request);
        if ($agentId === null) {
            return response()->json([
                'ok'    => false,
                'error' => 'Unauthorized: missing agent or tenant context.',
            ], 401);
        }

        $degraded = [];

        // -------- Mode A: cross-session lookup by context_tag --------
        if ($contextTag) {
            try {
                $rows = Memory::query()
                    ->where('agent_id', $agentId)
                    ->where('context_tag', $contextTag)
                    ->orderBy('created_at', 'asc')
                    ->limit($limit)
                    ->get();

                return response()->json([
                    'ok'          => true,
                    'context_tag' => $contextTag,
                    'memories'    => $this->shape($rows),
                    'meta'        => [
                        'memory_source' => 'database',
                        'count'         => $rows->count(),
                        'generated_at'  => Carbon::now()->toIso8601String(),
                    ],
                ]);
            } catch (\Throwable $e) {
                Log::error("Memory fetch (tag) failed agent={$agentId} tag={$contextTag}: " . $e->getMessage(), ['exception' => $e]);
                return response()->json([
                    'ok'       => false,
                    'error'    => 'Database error while fetching historical memories.',
                    'memories' => [],
                ], 500);
            }
        }

        // -------- Mode B: session fetch (the bridge's path) --------
        $state = [];

        // Optional session key/value state from cache (bridge ignores this today,
        // but it is preserved for future use and degrades quietly).
        try {
            $indexKey   = "session_mem_index:{$sessionId}";
            $cachedKeys = Cache::get($indexKey, []);

            if (is_array($cachedKeys) && !empty($cachedKeys)) {
                $map = [];
                foreach ($cachedKeys as $k) {
                    $map[$k] = "session_mem:{$sessionId}:{$k}";
                }
                $raw = Cache::many(array_values($map));
                foreach ($map as $orig => $full) {
                    if (($raw[$full] ?? null) !== null) {
                        $state[$orig] = $raw[$full];
                    }
                }
            }
        } catch (\Throwable $e) {
            Log::warning("Cache unavailable, session={$sessionId}: " . $e->getMessage());
            $degraded[] = 'cache_unavailable';
        }

        // Database memories — this is what the bridge actually injects.
        try {
            $rows = Memory::query()
                ->where('agent_id', $agentId)
                ->where('session_id', $sessionId)
                ->orderBy('created_at', 'asc')
                ->limit($limit)
                ->get();
        } catch (\Throwable $e) {
            Log::error("Memory fetch (session) failed agent={$agentId} session={$sessionId}: " . $e->getMessage(), ['exception' => $e]);
            $rows = collect();
            $degraded[] = 'database_unavailable';
        }

        // Source label + status.
        $source = 'database+cache';
        if (in_array('cache_unavailable', $degraded) && in_array('database_unavailable', $degraded)) {
            $source = 'none';
        } elseif (in_array('cache_unavailable', $degraded)) {
            $source = 'database';
        } elseif (in_array('database_unavailable', $degraded)) {
            $source = 'cache';
        }

        $bothDown = count($degraded) === 2;

        return response()->json([
            'ok'         => !$bothDown,
            'session_id' => $sessionId,
            'state'      => (object) $state,
            'memories'   => $this->shape($rows),
            'meta'       => [
                'memory_source' => $source,
                'degraded'      => $degraded,
                'count'         => $rows->count(),
                'limit'         => $limit,
                'generated_at'  => Carbon::now()->toIso8601String(),
            ],
        ], $bothDown ? 503 : 200);
    }

    // ==================================================================
    //  WRITE  — POST /api/agent-memory/store   (fixes the 500)
    // ==================================================================
    public function store(Request $request)
    {
        $data = $request->validate([
            'session_id'  => ['required', 'string', 'max:191'],
            'role'        => ['sometimes', 'nullable', 'string', 'max:32'],
            'content'     => ['required', 'string'],
            'context_tag' => ['sometimes', 'nullable', 'string', 'max:191'],
        ]);

        $agentId = $this->resolveAgentId($request);
        if ($agentId === null) {
            return response()->json([
                'ok'    => false,
                'error' => 'Unauthorized: missing agent or tenant context.',
            ], 401);
        }

        try {
            $memory = Memory::create([
                'agent_id'    => $agentId,
                'session_id'  => $data['session_id'],
                'context_tag' => $data['context_tag'] ?? null,
                'role'        => $data['role'] ?? 'user',
                'content'     => $data['content'],
            ]);

            return response()->json([
                'ok'         => true,
                'id'         => $memory->id,
                'session_id' => $memory->session_id,
                'meta'       => [
                    'stored_at' => Carbon::now()->toIso8601String(),
                ],
            ], 201);
        } catch (\Throwable $e) {
            Log::error("Memory store failed agent={$agentId} session={$data['session_id']}: " . $e->getMessage(), ['exception' => $e]);
            return response()->json([
                'ok'    => false,
                'error' => 'Database error while storing memory.',
            ], 500);
        }
    }

    // ==================================================================
    //  HELPERS
    // ==================================================================

    /**
     * Resolve the tenant scope used for BOTH reads and writes.
     *
     * Order:
     *   1. request attribute 'agent_id'  — set this in the X-Agent-Key middleware
     *      if you are multi-tenant (recommended: map each key to an agent_id).
     *   2. auth()->id()                  — if a real auth guard is present.
     *   3. config('bridge.default_agent_id') — single-tenant fallback so the
     *      server-to-server bridge call never 401s. Ships as 'bridge-user'.
     *
     * Returns null only if you have explicitly disabled the default (set it to
     * null in config) AND neither of the first two produced a value.
     */
    private function resolveAgentId(Request $request): ?string
    {
        $fromMiddleware = $request->attributes->get('agent_id');
        if (!empty($fromMiddleware)) {
            return (string) $fromMiddleware;
        }

        if (function_exists('auth') && auth()->id()) {
            return (string) auth()->id();
        }

        $default = config('bridge.default_agent_id', 'bridge-user');
        return $default !== null ? (string) $default : null;
    }

    /**
     * Normalize rows into the shape the bridge expects: each item exposes
     * `content` (what ChatController reads) plus id/role/created_at for clients
     * that want them. Reads `role`, falls back to a legacy `source` column.
     */
    private function shape($rows): array
    {
        return $rows->map(function ($m) {
            return [
                'id'          => $m->id,
                'context_tag' => $m->context_tag ?? null,
                'role'        => $m->role ?? ($m->source ?? 'system'),
                'content'     => $m->content,
                'created_at'  => $m->created_at ? Carbon::parse($m->created_at)->toIso8601String() : null,
            ];
        })->all();
    }
}
