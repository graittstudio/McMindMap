<?php
// SQLite connection + schema. The database lives OUTSIDE the web docroot so it
// is never served. Override the path with the MCMINDMAP_DB env var (used by CI).
declare(strict_types=1);

function db(): PDO {
    static $pdo = null;
    if ($pdo !== null) return $pdo;

    $path = getenv('MCMINDMAP_DB');
    if (!$path) $path = '/var/www/mcmindmap-data/mcmindmap.db';

    $dir = dirname($path);
    if (!is_dir($dir)) @mkdir($dir, 0750, true);

    $pdo = new PDO('sqlite:' . $path);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    $pdo->exec('PRAGMA journal_mode = WAL');
    $pdo->exec('PRAGMA foreign_keys = ON');
    init_schema($pdo);
    return $pdo;
}

function init_schema(PDO $pdo): void {
    $pdo->exec("
        CREATE TABLE IF NOT EXISTS users (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
            password_hash TEXT NOT NULL,
            role          TEXT NOT NULL DEFAULT 'user',
            display_name  TEXT NOT NULL DEFAULT '',
            prefs         TEXT NOT NULL DEFAULT '{}',
            must_change   INTEGER NOT NULL DEFAULT 0,
            created_at    TEXT NOT NULL DEFAULT (datetime('now'))
        )
    ");
    $pdo->exec("
        CREATE TABLE IF NOT EXISTS maps (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    INTEGER NOT NULL,
            title      TEXT NOT NULL DEFAULT 'Untitled',
            data       TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    ");
    $pdo->exec("CREATE INDEX IF NOT EXISTS idx_maps_user ON maps(user_id)");

    // Migration: add the email column to existing databases if missing.
    $cols = $pdo->query("PRAGMA table_info(users)")->fetchAll(PDO::FETCH_COLUMN, 1);
    if (!in_array('email', $cols, true)) {
        $pdo->exec("ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT ''");
    }

    // Password-reset tokens (only the SHA-256 hash is stored, single-use, with expiry).
    $pdo->exec("
        CREATE TABLE IF NOT EXISTS password_resets (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    INTEGER NOT NULL,
            token_hash TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            used       INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    ");
    $pdo->exec("CREATE INDEX IF NOT EXISTS idx_resets_hash ON password_resets(token_hash)");
}
