<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Deploy to: app/Models/Memory.php
 *
 * Matches the canonical migration. The $fillable list is what makes
 * Memory::create([...]) in the store path work — a missing entry here is a
 * very common cause of a silent write failure or a MassAssignmentException.
 */
class Memory extends Model
{
    protected $table = 'memories';

    protected $fillable = [
        'agent_id',
        'session_id',
        'context_tag',
        'role',
        'content',
    ];

    protected $casts = [
        'created_at' => 'datetime',
        'updated_at' => 'datetime',
    ];
}
