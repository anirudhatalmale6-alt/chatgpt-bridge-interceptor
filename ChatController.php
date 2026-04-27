<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * ChatController — Pure Context Pipeline (v3.0.0)
 *
 * POST /api/chat
 *
 * Assembles raw context (time + identity + memory) and returns it directly.
 * Does NOT call OpenAI. The userscript injects this context as a system message
 * into ChatGPT's own conversation, so ChatGPT processes it natively.
 */
class ChatController extends Controller
{
    public function handle(Request $request)
    {
        $request->validate([
            'user_id'      => 'nullable|string|max:128',
            'session_id'   => 'nullable|string|max:128',
            'message'      => 'required|string|max:4000',
            'write_memory' => 'nullable|boolean',
        ]);

        $sessionId   = $request->input('session_id', 'default');
        $userMessage = $request->input('message');
        $writeMemory = $request->boolean('write_memory', false);

        // ------------------------------------------------------------------
        // STEP 1: Fetch current time
        // ------------------------------------------------------------------
        $timeBlock = '[SERVER_TIME] unavailable';
        try {
            $timeResponse = Http::withHeaders([
                'X-Agent-Key' => env('AGENT_TIME_API_KEY'),
            ])->timeout(5)->get(config('app.url') . '/api/time/status');

            if ($timeResponse->successful()) {
                $timeData  = $timeResponse->json();
                $timeBlock = '[SERVER_TIME] The exact current time is: ' . $timeData['local_time'] . ' Eastern. Report this time exactly, do not estimate or round.';
            }
        } catch (\Exception $e) {
            Log::warning('ChatController: time endpoint failed', ['error' => $e->getMessage()]);
        }

        // ------------------------------------------------------------------
        // STEP 2: Time awareness instruction
        // ------------------------------------------------------------------
        $timeAwareness = 'You have a persistent, real-time awareness of the server clock. This is your personal sense of "now." Reference the time naturally to anchor yourself in the present moment. Use this to maintain narrative consistency without waiting for the user to ask.';

        // ------------------------------------------------------------------
        // STEP 3: Fetch relevant memories
        // ------------------------------------------------------------------
        $memoryBlock = '';
        try {
            $memoryResponse = Http::withHeaders([
                'X-Agent-Key' => env('AGENT_TIME_API_KEY'),
            ])->timeout(5)->get(config('app.url') . '/api/agent-memory', [
                'session_id' => $sessionId,
                'limit'      => 10,
            ]);

            if ($memoryResponse->successful()) {
                $memories = $memoryResponse->json('memories', []);
                if (!empty($memories)) {
                    $memoryLines = array_map(
                        fn($m) => '- ' . (is_array($m) ? ($m['content'] ?? json_encode($m)) : $m),
                        $memories
                    );
                    $memoryBlock = "[MEMORY]\n" . implode("\n", $memoryLines);
                }
            }
        } catch (\Exception $e) {
            Log::warning('ChatController: memory endpoint failed', ['error' => $e->getMessage()]);
        }

        // ------------------------------------------------------------------
        // STEP 4: Store user message in memory (if requested)
        // ------------------------------------------------------------------
        if ($writeMemory) {
            try {
                Http::withHeaders([
                    'X-Agent-Key' => env('AGENT_TIME_API_KEY'),
                ])->timeout(5)->post(config('app.url') . '/api/agent-memory/store', [
                    'session_id' => $sessionId,
                    'role'       => 'user',
                    'content'    => $userMessage,
                ]);
            } catch (\Exception $e) {
                Log::warning('ChatController: memory store failed', ['error' => $e->getMessage()]);
            }
        }

        // ------------------------------------------------------------------
        // STEP 5: Assemble and return raw context (NO OpenAI call)
        //
        // The userscript injects this directly as a system message into
        // ChatGPT's own conversation payload, so ChatGPT processes it
        // as native context — not as a foreign injected note.
        // ------------------------------------------------------------------
        $parts         = array_filter([$timeBlock, $timeAwareness, $memoryBlock]);
        $systemContext  = implode("\n\n", $parts);

        return response()->json([
            'success'          => true,
            'injected_context' => $systemContext,
        ]);
    }
}
