<?php
// McMindMap JSON API front controller.  All requests go to
// api/index.php?action=<name>.  Auth is a PHP session cookie; mutating
// requests must carry the session CSRF token in the X-CSRF-Token header.
declare(strict_types=1);

require __DIR__ . '/db.php';

$https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off');
session_set_cookie_params([
    'lifetime' => 0, 'path' => '/', 'httponly' => true,
    'secure' => $https, 'samesite' => 'Lax',
]);
session_name('mcm_session');
session_start();

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

function out($data, int $code = 200): void {
    http_response_code($code);
    echo json_encode($data);
    exit;
}
function fail(string $msg, int $code = 400): void { out(['error' => $msg], $code); }

function body(): array {
    $raw = file_get_contents('php://input');
    if ($raw === '' || $raw === false) return [];
    $j = json_decode($raw, true);
    return is_array($j) ? $j : [];
}

function current_user(): ?array {
    if (empty($_SESSION['uid'])) return null;
    $st = db()->prepare('SELECT * FROM users WHERE id = ?');
    $st->execute([$_SESSION['uid']]);
    $u = $st->fetch();
    return $u ?: null;
}

function require_user(): array {
    $u = current_user();
    if (!$u) fail('not authenticated', 401);
    return $u;
}

function require_csrf(): void {
    $sent = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
    if (!$sent || !hash_equals($_SESSION['csrf'] ?? '', $sent)) fail('bad csrf token', 403);
}

function csrf_token(): string {
    if (empty($_SESSION['csrf'])) $_SESSION['csrf'] = bin2hex(random_bytes(32));
    return $_SESSION['csrf'];
}

function public_user(array $u): array {
    return [
        'id' => (int)$u['id'],
        'username' => $u['username'],
        'role' => $u['role'],
        'display_name' => $u['display_name'],
        'prefs' => json_decode($u['prefs'] ?: '{}', true) ?: new stdClass(),
        'must_change' => (bool)$u['must_change'],
    ];
}

$action = $_GET['action'] ?? '';
$isPost = ($_SERVER['REQUEST_METHOD'] === 'POST');

// ---- Public ---------------------------------------------------------------

if ($action === 'login') {
    if (!$isPost) fail('POST required', 405);
    $b = body();
    $username = trim((string)($b['username'] ?? ''));
    $password = (string)($b['password'] ?? '');
    if ($username === '' || $password === '') fail('username and password required');
    $st = db()->prepare('SELECT * FROM users WHERE username = ?');
    $st->execute([$username]);
    $u = $st->fetch();
    if (!$u || !password_verify($password, $u['password_hash'])) {
        usleep(300000);
        fail('invalid credentials', 401);
    }
    session_regenerate_id(true);
    $_SESSION['uid'] = (int)$u['id'];
    csrf_token();
    out(['user' => public_user($u), 'csrf' => $_SESSION['csrf']]);
}

if ($action === 'me') {
    $u = current_user();
    if (!$u) out(['user' => null], 200);
    out(['user' => public_user($u), 'csrf' => csrf_token()]);
}

if ($action === 'logout') {
    if (!$isPost) fail('POST required', 405);
    $_SESSION = [];
    if (ini_get('session.use_cookies')) {
        $p = session_get_cookie_params();
        setcookie(session_name(), '', time() - 42000, $p['path'], $p['domain'] ?? '', $p['secure'], $p['httponly']);
    }
    session_destroy();
    out(['ok' => true]);
}

// ---- Authenticated --------------------------------------------------------

$user = require_user();
if ($isPost) require_csrf();

switch ($action) {

case 'change_password':
    if (!$isPost) fail('POST required', 405);
    $b = body();
    $current = (string)($b['current'] ?? '');
    $new = (string)($b['new'] ?? '');
    if (!$user['must_change'] && !password_verify($current, $user['password_hash'])) {
        fail('current password is incorrect', 403);
    }
    if (strlen($new) < 8) fail('new password must be at least 8 characters');
    $hash = password_hash($new, PASSWORD_DEFAULT);
    $st = db()->prepare('UPDATE users SET password_hash = ?, must_change = 0 WHERE id = ?');
    $st->execute([$hash, $user['id']]);
    out(['ok' => true]);

case 'save_prefs':
    if (!$isPost) fail('POST required', 405);
    $b = body();
    $prefs = $b['prefs'] ?? null;
    if (!is_array($prefs)) fail('prefs object required');
    $st = db()->prepare('UPDATE users SET prefs = ? WHERE id = ?');
    $st->execute([json_encode($prefs), $user['id']]);
    out(['ok' => true]);

case 'maps':
    $st = db()->prepare('SELECT id, title, created_at, updated_at FROM maps WHERE user_id = ? ORDER BY updated_at DESC');
    $st->execute([$user['id']]);
    out(['maps' => $st->fetchAll()]);

case 'map':
    $id = (int)($_GET['id'] ?? 0);
    $st = db()->prepare('SELECT id, title, data, created_at, updated_at FROM maps WHERE id = ? AND user_id = ?');
    $st->execute([$id, $user['id']]);
    $m = $st->fetch();
    if (!$m) fail('map not found', 404);
    $m['data'] = json_decode($m['data'] ?: '{}', true);
    out(['map' => $m]);

case 'save_map':
    if (!$isPost) fail('POST required', 405);
    $b = body();
    $title = trim((string)($b['title'] ?? 'Untitled')) ?: 'Untitled';
    $data = $b['data'] ?? null;
    if (!is_array($data)) fail('data object required');
    $json = json_encode($data);
    $id = (int)($b['id'] ?? 0);
    if ($id > 0) {
        $st = db()->prepare('UPDATE maps SET title = ?, data = ?, updated_at = datetime(\'now\') WHERE id = ? AND user_id = ?');
        $st->execute([$title, $json, $id, $user['id']]);
        if ($st->rowCount() === 0) fail('map not found', 404);
    } else {
        $st = db()->prepare('INSERT INTO maps (user_id, title, data) VALUES (?, ?, ?)');
        $st->execute([$user['id'], $title, $json]);
        $id = (int)db()->lastInsertId();
    }
    $st = db()->prepare('SELECT id, title, updated_at FROM maps WHERE id = ?');
    $st->execute([$id]);
    out(['map' => $st->fetch()]);

case 'delete_map':
    if (!$isPost) fail('POST required', 405);
    $id = (int)(body()['id'] ?? 0);
    $st = db()->prepare('DELETE FROM maps WHERE id = ? AND user_id = ?');
    $st->execute([$id, $user['id']]);
    out(['ok' => true]);

// ---- Admin ----------------------------------------------------------------

case 'users':
    if ($user['role'] !== 'admin') fail('admin only', 403);
    $rows = db()->query('SELECT id, username, role, display_name, must_change, created_at FROM users ORDER BY username')->fetchAll();
    out(['users' => $rows]);

case 'create_user':
    if ($user['role'] !== 'admin') fail('admin only', 403);
    if (!$isPost) fail('POST required', 405);
    $b = body();
    $username = trim((string)($b['username'] ?? ''));
    $password = (string)($b['password'] ?? '');
    $role = ($b['role'] ?? 'user') === 'admin' ? 'admin' : 'user';
    $display = trim((string)($b['display_name'] ?? $username));
    if (!preg_match('/^[A-Za-z0-9_.-]{2,32}$/', $username)) fail('invalid username');
    if (strlen($password) < 8) fail('password must be at least 8 characters');
    $st = db()->prepare('INSERT INTO users (username, password_hash, role, display_name, must_change) VALUES (?, ?, ?, ?, 1)');
    try {
        $st->execute([$username, password_hash($password, PASSWORD_DEFAULT), $role, $display]);
    } catch (PDOException $e) {
        fail('username already exists', 409);
    }
    out(['ok' => true, 'id' => (int)db()->lastInsertId()]);

case 'reset_password':
    if ($user['role'] !== 'admin') fail('admin only', 403);
    if (!$isPost) fail('POST required', 405);
    $b = body();
    $id = (int)($b['id'] ?? 0);
    $password = (string)($b['password'] ?? '');
    if (strlen($password) < 8) fail('password must be at least 8 characters');
    $st = db()->prepare('UPDATE users SET password_hash = ?, must_change = 1 WHERE id = ?');
    $st->execute([password_hash($password, PASSWORD_DEFAULT), $id]);
    out(['ok' => true]);

case 'delete_user':
    if ($user['role'] !== 'admin') fail('admin only', 403);
    if (!$isPost) fail('POST required', 405);
    $id = (int)(body()['id'] ?? 0);
    if ($id === (int)$user['id']) fail('cannot delete yourself', 400);
    $st = db()->prepare('DELETE FROM users WHERE id = ?');
    $st->execute([$id]);
    out(['ok' => true]);

default:
    fail('unknown action', 404);
}
