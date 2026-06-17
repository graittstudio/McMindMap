<?php
// Test seed: drops nothing (db.php init_schema is idempotent), inserts two
// well-known users for the test cases to log in as. Uses the same MCMINDMAP_DB
// env-var override the production stack already supports.
declare(strict_types=1);

require __DIR__ . '/../../api/db.php';
$pdo = db();   // also runs init_schema

$pdo->prepare('INSERT OR IGNORE INTO users (username, password_hash, role, display_name, email, must_change) VALUES (?, ?, "user", ?, ?, 0)')
    ->execute(['alice', password_hash('alice123', PASSWORD_DEFAULT), 'Alice', 'alice@example.com']);
$pdo->prepare('INSERT OR IGNORE INTO users (username, password_hash, role, display_name, email, must_change) VALUES (?, ?, "user", ?, ?, 0)')
    ->execute(['bob', password_hash('bob1234', PASSWORD_DEFAULT), 'Bob', 'bob@example.com']);

echo "seeded alice & bob at " . getenv('MCMINDMAP_DB') . "\n";
