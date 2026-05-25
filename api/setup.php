<?php
// CLI-only user seeding / management.  Never reachable over the web.
//
//   php api/setup.php <username> <password> <role> [display_name]
//
// Creates the user, or updates the password/role if it already exists.
// Always sets must_change = 1 so the account must pick a new password on
// first login.  Used once on sebas to seed admin + menno.
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit("forbidden\n");
}

require __DIR__ . '/db.php';

$username = $argv[1] ?? '';
$password = $argv[2] ?? '';
$role     = ($argv[3] ?? 'user') === 'admin' ? 'admin' : 'user';
$display  = $argv[4] ?? $username;

if ($username === '' || $password === '') {
    fwrite(STDERR, "usage: php setup.php <username> <password> <role> [display_name]\n");
    exit(2);
}
if (strlen($password) < 8) {
    fwrite(STDERR, "password must be at least 8 characters\n");
    exit(2);
}

$hash = password_hash($password, PASSWORD_DEFAULT);
$pdo = db();
$st = $pdo->prepare('SELECT id FROM users WHERE username = ?');
$st->execute([$username]);
$existing = $st->fetch();

if ($existing) {
    $up = $pdo->prepare('UPDATE users SET password_hash = ?, role = ?, display_name = ?, must_change = 1 WHERE id = ?');
    $up->execute([$hash, $role, $display, $existing['id']]);
    echo "updated user '$username' (role=$role)\n";
} else {
    $in = $pdo->prepare('INSERT INTO users (username, password_hash, role, display_name, must_change) VALUES (?, ?, ?, ?, 1)');
    $in->execute([$username, $hash, $role, $display]);
    echo "created user '$username' (role=$role)\n";
}
