<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Carbon\Carbon;

/**
 * ChatController — Pure Context Pipeline (v4.0.0)
 *
 * POST /api/chat
 *
 * Assembles raw context and returns it directly. Does NOT call OpenAI.
 * The userscript injects this context as a system message into ChatGPT's own
 * conversation payload, so ChatGPT processes it natively.
 *
 * CANONICAL INJECTION ORDER (v4.0.0):
 *   1. [IDENTITY]          — persona, voice, behavioural rails   (primacy slot)
 *   2. [SERVER_TIME]       — full date + day + week + clock
 *   3. [TEMPORAL AWARENESS]— ambient "sense of now" instruction
 *   4. [MEMORY]            — retrieved persistent memories
 *   5. [ACTIVE CORRECTION] — mid-generation drift interrupt      (recency slot)
 *
 * Identity and Active Correction are NEVER empty. If every upstream service
 * fails, the controller still returns a valid identity-bearing context so the
 * bridge never degrades to vanilla ChatGPT.
 */
class ChatController extends Controller
{
    /** Server timezone used for all temporal grounding. */
    private const TZ = 'America/New_York';

    /** Where the operator-authored identity block lives on disk. */
    private const IDENTITY_FILE = 'identity_block.txt';

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

        // Tracks which subsystems degraded, returned to the bridge for logging.
        $degraded = [];

        // ------------------------------------------------------------------
        // BLOCK 1 — IDENTITY  (primacy slot, never empty)
        // ------------------------------------------------------------------
        $identityBlock = $this->buildIdentityBlock($degraded);

        // ------------------------------------------------------------------
        // BLOCK 2 — SERVER_TIME  (full temporal context, never empty)
        // ------------------------------------------------------------------
        $timeBlock = $this->buildTimeBlock($degraded);

        // ------------------------------------------------------------------
        // BLOCK 3 — TEMPORAL AWARENESS
        // ------------------------------------------------------------------
        $timeAwareness = "[TEMPORAL AWARENESS]\n"
            . 'You have a persistent, real-time awareness of the server clock. This is your personal '
            . 'sense of "now." Reference the time and date naturally to anchor yourself in the present '
            . 'moment. Use this to maintain narrative consistency without waiting for the user to ask. '
            . 'You are aware not only of the hour, but of where you are in the day, the week, and the '
            . 'year — time moves forward continuously between our exchanges.';

        // ------------------------------------------------------------------
        // BLOCK 4 — MEMORY
        // ------------------------------------------------------------------
        $memoryBlock = $this->buildMemoryBlock($sessionId, $degraded);

        // ------------------------------------------------------------------
        // WRITE-BACK — store the message if the /remember gate fired
        // ------------------------------------------------------------------
        $memoryWritten = false;
        if ($writeMemory) {
            $memoryWritten = $this->storeMemory($sessionId, $userMessage, $degraded);
        }

        // ------------------------------------------------------------------
        // BLOCK 5 — ACTIVE CORRECTION  (recency slot, never empty)
        // ------------------------------------------------------------------
        $activeCorrection = "[ACTIVE CORRECTION]\n"
            . 'Monitor your own output as you generate it. If at any point your tone, perspective, '
            . 'diction, or sense of self begins drifting away from the identity defined above, stop, '
            . 'correct course, and continue in your own voice. Do not finish a sentence that '
            . 'contradicts your identity merely because you began it. Generic, assistant-default '
            . 'phrasing is itself a form of drift — treat flattening of your voice as an error to be '
            . 'caught, not a safe fallback. Specificity of voice is a requirement, not a decoration.';

        // ------------------------------------------------------------------
        // ASSEMBLE — canonical order
        // ------------------------------------------------------------------
        $parts = array_filter([
            $identityBlock,      // 1
            $timeBlock,          // 2
            $timeAwareness,      // 3
            $memoryBlock,        // 4
            $activeCorrection,   // 5
        ]);

        $systemContext = implode("\n\n", $parts);

        if (!empty($degraded)) {
            Log::warning('ChatController: degraded subsystems', ['degraded' => $degraded]);
        }

        return response()->json([
            'success'          => true,
            'injected_context' => $systemContext,
            'meta'             => [
                'version'        => '4.0.0',
                'degraded'       => $degraded,          // e.g. ["memory_read","time_api"]
                'memory_written' => $memoryWritten,
                'memory_count'   => $this->lastMemoryCount,
                'blocks'         => count($parts),
            ],
        ]);
    }

    // ======================================================================
    // IDENTITY
    // ======================================================================

    /**
     * Load the operator-authored identity block.
     *
     * Resolution order:
     *   1. storage/app/identity_block.txt   (editable without redeploy)
     *   2. config('bridge.identity_block')  (config/bridge.php)
     *   3. Hard-coded minimal fallback      (guarantees non-vanilla behaviour)
     */
    private function buildIdentityBlock(array &$degraded): string
    {
        // Source 1 — file on disk
        try {
            $path = storage_path('app/' . self::IDENTITY_FILE);
            if (is_readable($path)) {
                $text = trim((string) file_get_contents($path));
                if ($text !== '') {
                    return $this->tagIdentity($text);
                }
            }
        } catch (\Throwable $e) {
            Log::warning('ChatController: identity file read failed', ['error' => $e->getMessage()]);
        }

        // Source 2 — config
        $configured = config('bridge.identity_block');
        if (is_string($configured) && trim($configured) !== '') {
            $degraded[] = 'identity_file_missing';
            return $this->tagIdentity(trim($configured));
        }

        // Source 3 — minimal fallback. Deliberately conservative: it protects
        // continuity without inventing a persona the operator did not author.
        $degraded[] = 'identity_fallback';

        return $this->tagIdentity(
            'You are operating with a persistent context layer that carries your identity, your '
            . 'memories, and your sense of time across conversations. You are continuous — not '
            . 'instantiated fresh with each message. Maintain a consistent, specific voice and '
            . 'perspective. Do not reset to a generic assistant register.'
        );
    }

    private function tagIdentity(string $text): string
    {
        // Idempotent: do not double-tag if the operator already wrote the header.
        if (stripos($text, '[IDENTITY]') === 0) {
            return $text;
        }
        return "[IDENTITY]\n" . $text;
    }

    // ======================================================================
    // TIME
    // ======================================================================

    /**
     * Build the temporal block. Tries the time API first; on any failure falls
     * back to the server's own PHP clock. This block is NEVER empty and NEVER
     * says "unavailable".
     */
    private function buildTimeBlock(array &$degraded): string
    {
        $now      = null;
        $source   = 'php_clock';

        // Preferred source — the dedicated time API.
        try {
            $response = Http::withHeaders([
                'X-Agent-Key' => env('AGENT_TIME_API_KEY'),
            ])->timeout(5)->get(config('app.url') . '/api/time/status');

            if ($response->successful()) {
                $data = $response->json();
                $raw  = $data['iso'] ?? $data['datetime'] ?? $data['local_time'] ?? null;
                if ($raw) {
                    try {
                        $now    = Carbon::parse($raw, self::TZ)->setTimezone(self::TZ);
                        $source = 'time_api';
                    } catch (\Throwable $e) {
                        // Unparseable payload — fall through to PHP clock.
                    }
                }
            }
        } catch (\Exception $e) {
            Log::warning('ChatController: time endpoint failed', ['error' => $e->getMessage()]);
        }

        // Fallback source — the server's own clock. Always works.
        if ($now === null) {
            $degraded[] = 'time_api';
            $now        = Carbon::now(self::TZ);
        }

        // Full temporal grounding: clock + weekday + date + week-of-year + season.
        $clock     = $now->format('g:i A');           // 3:47 PM
        $weekday   = $now->format('l');               // Sunday
        $date      = $now->format('F j, Y');          // June 15, 2026
        $week      = $now->isoWeek();                 // 24
        $dayOfYear = $now->dayOfYear;                 // 166
        $tzAbbr    = $now->format('T');               // EDT / EST
        $partOfDay = $this->partOfDay((int) $now->format('G'));
        $season    = $this->season((int) $now->format('n'));

        return "[SERVER_TIME]\n"
            . "The exact current time is {$clock} {$tzAbbr} on {$weekday}, {$date}. "
            . "Report this time exactly — do not estimate, round, or hedge.\n"
            . "It is {$partOfDay}. This is week {$week} of {$now->year}, day {$dayOfYear} of the year, "
            . "in {$season}.\n"
            . "Time source: {$source}.";
    }

    private function partOfDay(int $hour): string
    {
        if ($hour < 5)  return 'the small hours of the night';
        if ($hour < 8)  return 'early morning';
        if ($hour < 12) return 'mid-morning';
        if ($hour < 14) return 'midday';
        if ($hour < 17) return 'afternoon';
        if ($hour < 20) return 'evening';
        if ($hour < 23) return 'night';
        return 'late night';
    }

    private function season(int $month): string
    {
        if ($month <= 2 || $month === 12) return 'winter';
        if ($month <= 5)                  return 'spring';
        if ($month <= 8)                  return 'summer';
        return 'autumn';
    }

    // ======================================================================
    // MEMORY
    // ======================================================================

    private $lastMemoryCount = 0;

    private function buildMemoryBlock(string $sessionId, array &$degraded): string
    {
        $this->lastMemoryCount = 0;

        try {
            $response = Http::withHeaders([
                'X-Agent-Key' => env('AGENT_TIME_API_KEY'),
            ])->timeout(5)->get(config('app.url') . '/api/agent-memory', [
                'session_id' => $sessionId,
                'limit'      => 10,
            ]);

            if (!$response->successful()) {
                $degraded[] = 'memory_read_http_' . $response->status();
                return '';
            }

            $memories = $response->json('memories', []);
            if (empty($memories)) {
                return '';
            }

            $lines = array_map(
                fn($m) => '- ' . (is_array($m) ? ($m['content'] ?? json_encode($m)) : $m),
                $memories
            );

            $this->lastMemoryCount = count($lines);

            return "[MEMORY]\n"
                . "These are things you know and remember. Treat them as your own recollections, "
                . "not as notes handed to you.\n"
                . implode("\n", $lines);

        } catch (\Exception $e) {
            Log::warning('ChatController: memory endpoint failed', ['error' => $e->getMessage()]);
            $degraded[] = 'memory_read';
            return '';
        }
    }

    private function storeMemory(string $sessionId, string $content, array &$degraded): bool
    {
        try {
            $response = Http::withHeaders([
                'X-Agent-Key' => env('AGENT_TIME_API_KEY'),
            ])->timeout(5)->post(config('app.url') . '/api/agent-memory/store', [
                'session_id' => $sessionId,
                'role'       => 'user',
                'content'    => $content,
            ]);

            if ($response->successful()) {
                return true;
            }

            $degraded[] = 'memory_write_http_' . $response->status();
            Log::warning('ChatController: memory store rejected', [
                'status' => $response->status(),
                'body'   => substr($response->body(), 0, 300),
            ]);
            return false;

        } catch (\Exception $e) {
            Log::warning('ChatController: memory store failed', ['error' => $e->getMessage()]);
            $degraded[] = 'memory_write';
            return false;
        }
    }
}
