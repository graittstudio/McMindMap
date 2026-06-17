<?php
// McMindMap JSON API front controller.  All requests go to
// api/index.php?action=<name>.  Auth is a PHP session cookie; mutating
// requests must carry the session CSRF token in the X-CSRF-Token header.
declare(strict_types=1);

require __DIR__ . '/db.php';

const MAIL_FROM = 'McMindMap <noreply@aukes.com>';
const APP_URL   = 'https://mindmap.apps.aukes.com';
const RESET_TTL = 3600;   // password-reset link valid for 1 hour

function send_mail(string $to, string $subject, string $body): bool {
    $headers = "From: " . MAIL_FROM . "\r\n" .
               "Content-Type: text/plain; charset=utf-8\r\n";
    return @mail($to, $subject, $body, $headers);
}

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
        'email' => $u['email'] ?? '',
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
    $st = db()->prepare('SELECT * FROM users WHERE username = ? OR (email <> "" AND email = ?)');
    $st->execute([$username, $username]);
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

if ($action === 'request_reset') {
    // Public. Always responds OK (never reveal whether an account exists).
    if (!$isPost) fail('POST required', 405);
    $login = trim((string)(body()['login'] ?? ''));
    if ($login !== '') {
        $st = db()->prepare('SELECT * FROM users WHERE username = ? OR (email <> "" AND email = ?)');
        $st->execute([$login, $login]);
        $u = $st->fetch();
        if ($u && !empty($u['email'])) {
            db()->prepare('DELETE FROM password_resets WHERE user_id = ?')->execute([$u['id']]);
            $token = bin2hex(random_bytes(32));
            $hash = hash('sha256', $token);
            $exp = date('Y-m-d H:i:s', time() + RESET_TTL);
            db()->prepare('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)')
                ->execute([$u['id'], $hash, $exp]);
            $link = APP_URL . '/reset.html?token=' . $token;
            $mailBody = "Hi " . ($u['display_name'] ?: $u['username']) . ",\n\n" .
                "Someone asked to reset the password for your McMindMap account (" . $u['username'] . ").\n" .
                "Open this link to choose a new password (valid for 1 hour):\n\n" . $link . "\n\n" .
                "If you didn't request this, you can ignore this email — your password stays unchanged.\n";
            send_mail($u['email'], 'Reset your McMindMap password', $mailBody);
        }
    }
    out(['ok' => true]);
}

if ($action === 'signup') {
    // Public, open beta. Creates an account when the email is fresh and
    // emails a setup-link (re-using the password_resets token machinery).
    // If the email is already taken we silently send a sign-in/reset link
    // to the owner instead -- the front-end shows the same "check your
    // inbox" message either way, so we never confirm whether an address
    // exists.
    if (!$isPost) fail('POST required', 405);
    $b = body();
    $email = trim((string)($b['email'] ?? ''));
    $name  = trim((string)($b['name'] ?? ''));
    if ($name === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        fail('Please enter your name and a valid email.');
    }

    $st = db()->prepare('SELECT * FROM users WHERE email = ?');
    $st->execute([$email]);
    $u = $st->fetch();
    $isNew = false;

    if (!$u) {
        $local = strtolower(strstr($email, '@', true));
        $base = preg_replace('/[^a-z0-9_-]/', '', $local);
        if ($base === '') $base = 'user';
        $username = $base;
        $check = db()->prepare('SELECT 1 FROM users WHERE username = ?');
        $n = 1;
        while (true) {
            $check->execute([$username]);
            if (!$check->fetch()) break;
            $username = $base . $n++;
        }
        $placeholder = password_hash(bin2hex(random_bytes(16)), PASSWORD_DEFAULT);
        db()->prepare('INSERT INTO users (username, password_hash, role, display_name, email, must_change) VALUES (?, ?, "user", ?, ?, 1)')
            ->execute([$username, $placeholder, $name, $email]);
        $u = [
            'id'           => (int)db()->lastInsertId(),
            'username'     => $username,
            'email'        => $email,
            'display_name' => $name,
        ];
        $isNew = true;
    }

    db()->prepare('DELETE FROM password_resets WHERE user_id = ?')->execute([$u['id']]);
    $token = bin2hex(random_bytes(32));
    $hash = hash('sha256', $token);
    $exp = date('Y-m-d H:i:s', time() + RESET_TTL);
    db()->prepare('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)')
        ->execute([$u['id'], $hash, $exp]);
    $link = APP_URL . '/reset.html?token=' . $token;

    if ($isNew) {
        $subject = 'Welcome to McMindMap';
        $mailBody = "Hi " . $u['display_name'] . ",\n\n" .
            "Your McMindMap account is ready. Open this link to choose a password (valid for 1 hour):\n\n" . $link . "\n\n" .
            "You can sign in with either your email (" . $u['email'] . ") or your username (" . $u['username'] . ").\n";
    } else {
        $subject = 'McMindMap — you already have an account';
        $mailBody = "Hi " . ($u['display_name'] ?: $u['username']) . ",\n\n" .
            "Someone tried to sign up at McMindMap with this email, but an account already exists.\n" .
            "If that was you, use this link to set a new password and sign in (valid for 1 hour):\n\n" . $link . "\n\n" .
            "Your username is: " . $u['username'] . "\n\n" .
            "If it wasn't you, ignore this email -- your password stays unchanged.\n";
    }
    send_mail($u['email'], $subject, $mailBody);
    out(['ok' => true]);
}

if ($action === 'reset_with_token') {
    if (!$isPost) fail('POST required', 405);
    $b = body();
    $token = (string)($b['token'] ?? '');
    $new = (string)($b['new'] ?? '');
    if (strlen($new) < 8) fail('new password must be at least 8 characters');
    if ($token === '') fail('invalid or expired link', 400);
    $hash = hash('sha256', $token);
    $st = db()->prepare("SELECT * FROM password_resets WHERE token_hash = ? AND used = 0 AND expires_at > datetime('now')");
    $st->execute([$hash]);
    $row = $st->fetch();
    if (!$row) fail('this reset link is invalid or has expired', 400);
    db()->prepare('UPDATE users SET password_hash = ?, must_change = 0 WHERE id = ?')
        ->execute([password_hash($new, PASSWORD_DEFAULT), $row['user_id']]);
    db()->prepare('UPDATE password_resets SET used = 1 WHERE id = ?')->execute([$row['id']]);
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
    if (array_key_exists('email', $b)) {
        $email = trim((string)$b['email']);
        if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) fail('invalid email address');
        db()->prepare('UPDATE users SET email = ? WHERE id = ?')->execute([$email, $user['id']]);
    }
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
    $rows = db()->query('SELECT id, username, role, display_name, email, must_change, created_at FROM users ORDER BY username')->fetchAll();
    out(['users' => $rows]);

case 'create_user':
    if ($user['role'] !== 'admin') fail('admin only', 403);
    if (!$isPost) fail('POST required', 405);
    $b = body();
    $username = trim((string)($b['username'] ?? ''));
    $password = (string)($b['password'] ?? '');
    $role = ($b['role'] ?? 'user') === 'admin' ? 'admin' : 'user';
    $display = trim((string)($b['display_name'] ?? $username));
    $email = trim((string)($b['email'] ?? ''));
    if (!preg_match('/^[A-Za-z0-9_.-]{2,32}$/', $username)) fail('invalid username');
    if (strlen($password) < 8) fail('password must be at least 8 characters');
    if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) fail('invalid email address');
    $st = db()->prepare('INSERT INTO users (username, password_hash, role, display_name, email, must_change) VALUES (?, ?, ?, ?, ?, 1)');
    try {
        $st->execute([$username, password_hash($password, PASSWORD_DEFAULT), $role, $display, $email]);
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

case 'set_email':
    if ($user['role'] !== 'admin') fail('admin only', 403);
    if (!$isPost) fail('POST required', 405);
    $b = body();
    $id = (int)($b['id'] ?? 0);
    $email = trim((string)($b['email'] ?? ''));
    if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) fail('invalid email address');
    db()->prepare('UPDATE users SET email = ? WHERE id = ?')->execute([$email, $id]);
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
