<?php
declare(strict_types=1);
require __DIR__ . '/lib.php';

echo "\n  McMindMap backend tests\n";

describe('me / login / logout', function () {
    reset_session();
    it('returns user=null when not signed in', function () {
        $r = api('GET', 'me');
        eq($r['code'], 200);
        eq($r['data']['user'], null);
    });
    it('rejects bad credentials', function () {
        $r = api('POST', 'login', ['username' => 'alice', 'password' => 'wrong']);
        eq($r['code'], 401);
    });
    it('signs alice in by username', function () {
        $r = api('POST', 'login', ['username' => 'alice', 'password' => 'alice123']);
        eq($r['code'], 200);
        eq($r['data']['user']['username'], 'alice');
    });
    it('signs alice in by email', function () {
        reset_session();
        $r = api('POST', 'login', ['username' => 'alice@example.com', 'password' => 'alice123']);
        eq($r['code'], 200);
        eq($r['data']['user']['username'], 'alice');
    });
    it('logout clears the session', function () {
        api('POST', 'logout', []);
        $r = api('GET', 'me');
        eq($r['data']['user'], null);
    });
});

describe('signup', function () {
    reset_session();
    it('creates a fresh account on first email', function () {
        $email = 'carol+' . substr(uniqid(), -6) . '@example.com';
        $r = api('POST', 'signup', ['name' => 'Carol', 'email' => $email]);
        eq($r['code'], 200);
        $pdo = new PDO('sqlite:' . getenv('MCMINDMAP_DB'));
        $row = $pdo->prepare('SELECT display_name, must_change FROM users WHERE email = ?');
        $row->execute([$email]);
        $u = $row->fetch(PDO::FETCH_ASSOC);
        truthy($u, 'new row exists');
        eq($u['display_name'], 'Carol');
        eq((int)$u['must_change'], 1);
    });
    it('rejects empty name', function () {
        $r = api('POST', 'signup', ['name' => '', 'email' => 'foo@example.com']);
        eq($r['code'], 400);
    });
    it('rejects non-email', function () {
        $r = api('POST', 'signup', ['name' => 'X', 'email' => 'not-an-email']);
        eq($r['code'], 400);
    });
});

describe('password reset', function () {
    // We can't reconstruct the plaintext token from the SHA-256 hash that lives
    // in the DB, so for the reset_with_token cases we inject a known token
    // directly. request_reset itself is tested via row-count: known login -> +1,
    // unknown -> +0 (anti-enumeration response is still 200).
    $pdo = new PDO('sqlite:' . getenv('MCMINDMAP_DB'));

    reset_session();
    it('request_reset for a known email creates a token row', function () use ($pdo) {
        $before = (int)$pdo->query('SELECT COUNT(*) FROM password_resets')->fetchColumn();
        $r = api('POST', 'request_reset', ['login' => 'alice@example.com']);
        eq($r['code'], 200);
        $after = (int)$pdo->query('SELECT COUNT(*) FROM password_resets')->fetchColumn();
        eq($after, $before + 1, 'one new row');
    });
    it('request_reset for an unknown login is silently OK and leaves the DB alone', function () use ($pdo) {
        $before = (int)$pdo->query('SELECT COUNT(*) FROM password_resets')->fetchColumn();
        $r = api('POST', 'request_reset', ['login' => 'noone@example.com']);
        eq($r['code'], 200);
        $after = (int)$pdo->query('SELECT COUNT(*) FROM password_resets')->fetchColumn();
        eq($after, $before, 'no new row');
    });
    it('reset_with_token swaps the password, marks the token used, and lets the new password log in', function () use ($pdo) {
        $token = 'reset-happy-token';
        $hash  = hash('sha256', $token);
        $uid   = (int)$pdo->query("SELECT id FROM users WHERE username='alice'")->fetchColumn();
        $pdo->prepare("INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, datetime('now','+1 hour'))")->execute([$uid, $hash]);
        $r = api('POST', 'reset_with_token', ['token' => $token, 'new' => 'reset-new-pass']);
        eq($r['code'], 200);
        $stmt = $pdo->prepare('SELECT used FROM password_resets WHERE token_hash = ?');
        $stmt->execute([$hash]);
        eq((int)$stmt->fetchColumn(), 1, 'token marked used');

        reset_session();
        $r = api('POST', 'login', ['username' => 'alice', 'password' => 'reset-new-pass']);
        eq($r['code'], 200, 'new password works');
        api('POST', 'logout', []);

        // restore alice's original password so downstream describes keep working
        $pdo->prepare('UPDATE users SET password_hash = ? WHERE username = ?')
            ->execute([password_hash('alice123', PASSWORD_DEFAULT), 'alice']);
    });
    it('reset_with_token rejects a token that was already used', function () use ($pdo) {
        $token = 'reset-used-token';
        $hash  = hash('sha256', $token);
        $uid   = (int)$pdo->query("SELECT id FROM users WHERE username='alice'")->fetchColumn();
        $pdo->prepare("INSERT INTO password_resets (user_id, token_hash, expires_at, used) VALUES (?, ?, datetime('now','+1 hour'), 1)")->execute([$uid, $hash]);
        $r = api('POST', 'reset_with_token', ['token' => $token, 'new' => 'should-not-work-1']);
        eq($r['code'], 400);
    });
    it('reset_with_token rejects an expired token', function () use ($pdo) {
        $token = 'reset-expired-token';
        $hash  = hash('sha256', $token);
        $uid   = (int)$pdo->query("SELECT id FROM users WHERE username='alice'")->fetchColumn();
        $pdo->prepare("INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, datetime('now','-1 hour'))")->execute([$uid, $hash]);
        $r = api('POST', 'reset_with_token', ['token' => $token, 'new' => 'should-not-work-2']);
        eq($r['code'], 400);
    });
    it('reset_with_token refuses a password shorter than 8 chars', function () use ($pdo) {
        $token = 'reset-short-pw';
        $hash  = hash('sha256', $token);
        $uid   = (int)$pdo->query("SELECT id FROM users WHERE username='alice'")->fetchColumn();
        $pdo->prepare("INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, datetime('now','+1 hour'))")->execute([$uid, $hash]);
        $r = api('POST', 'reset_with_token', ['token' => $token, 'new' => 'short']);
        eq($r['code'], 400);
    });
});

describe('maps CRUD', function () {
    reset_session();
    api('POST', 'login', ['username' => 'alice', 'password' => 'alice123']);
    it('alice starts with no maps', function () {
        $r = api('GET', 'maps');
        eq(count($r['data']['maps']), 0);
        eq(count($r['data']['shared']), 0);
    });
    it('creates a map', function () {
        $r = api('POST', 'save_map', [
            'title' => 'First',
            'data'  => ['nodes' => ['n1' => ['id' => 'n1', 'text' => 'root', 'x' => 0, 'y' => 0]], 'rootId' => 'n1'],
        ]);
        eq($r['code'], 200);
        truthy($r['data']['map']['id']);
        $GLOBALS['_mapId'] = (int)$r['data']['map']['id'];
    });
    it('reads the map back with access=owner', function () {
        $id = $GLOBALS['_mapId'];
        $r = api('GET', "map&id=$id");
        eq($r['code'], 200);
        eq($r['data']['map']['title'], 'First');
        eq($r['data']['map']['access'], 'owner');
    });
    it('renames the map', function () {
        $id = $GLOBALS['_mapId'];
        $r = api('POST', 'save_map', [
            'id'    => $id,
            'title' => 'Renamed',
            'data'  => ['nodes' => ['n1' => ['id' => 'n1', 'x' => 0, 'y' => 0]], 'rootId' => 'n1'],
        ]);
        eq($r['code'], 200);
        $r = api('GET', "map&id=$id");
        eq($r['data']['map']['title'], 'Renamed');
    });
    it('deletes the map', function () {
        $id = $GLOBALS['_mapId'];
        $r = api('POST', 'delete_map', ['id' => $id]);
        eq($r['code'], 200);
        $r = api('GET', "map&id=$id");
        eq($r['code'], 404);
    });
});

describe('sharing', function () {
    reset_session();
    api('POST', 'login', ['username' => 'alice', 'password' => 'alice123']);
    $r = api('POST', 'save_map', [
        'title' => 'Shared',
        'data'  => ['nodes' => ['n1' => ['id' => 'n1', 'x' => 0, 'y' => 0]], 'rootId' => 'n1'],
    ]);
    $mapId = (int)$r['data']['map']['id'];
    $GLOBALS['_mapId'] = $mapId;

    it('alice creates a read-only share link', function () use ($mapId) {
        $r = api('POST', 'share_link', ['map_id' => $mapId, 'rights' => 'read']);
        eq($r['code'], 200);
        truthy($r['data']['token']);
        eq($r['data']['rights'], 'read');
        eq($r['data']['active'], true);
        $GLOBALS['_token'] = $r['data']['token'];
    });
    it('bob sees the share info', function () {
        reset_session();
        api('POST', 'login', ['username' => 'bob', 'password' => 'bob1234']);
        $r = api('GET', 'share_info&token=' . $GLOBALS['_token']);
        eq($r['code'], 200);
        eq($r['data']['owner'], 'Alice');
        eq($r['data']['title'], 'Shared');
        eq($r['data']['is_owner'], false);
        eq($r['data']['already_claimed'], false);
    });
    it('bob claims the share', function () use ($mapId) {
        $r = api('POST', 'share_claim', ['token' => $GLOBALS['_token']]);
        eq($r['code'], 200);
        eq((int)$r['data']['map_id'], $mapId);
        $r = api('GET', 'maps');
        eq(count($r['data']['shared']), 1);
        eq((int)$r['data']['shared'][0]['id'], $mapId);
    });
    it('re-claiming is idempotent (no duplicate row, owner not re-notified)', function () use ($mapId) {
        // hitting the endpoint again should still 200 without inserting a
        // second share_claims row. The mail-to-owner branch only fires on
        // a fresh insert, so a re-claim stays quiet.
        $r = api('POST', 'share_claim', ['token' => $GLOBALS['_token']]);
        eq($r['code'], 200);
        $pdo = new PDO('sqlite:' . getenv('MCMINDMAP_DB'));
        $stm = $pdo->prepare('SELECT COUNT(*) FROM share_claims c JOIN map_shares s ON s.id = c.share_id WHERE s.map_id = ?');
        $stm->execute([$mapId]);
        eq((int)$stm->fetchColumn(), 1, 'one claim row, not two');
    });
    it('bob has read access and save_map is blocked', function () use ($mapId) {
        $r = api('GET', "map&id=$mapId");
        eq($r['data']['map']['access'], 'read');
        eq($r['data']['map']['owner_name'], 'Alice');
        $r = api('POST', 'save_map', [
            'id'    => $mapId,
            'title' => 'evil',
            'data'  => ['nodes' => ['n1' => ['id' => 'n1', 'x' => 0, 'y' => 0]], 'rootId' => 'n1'],
        ]);
        eq($r['code'], 403);
    });
    it('alice sees bob in share_state with rights=read', function () use ($mapId) {
        reset_session();
        api('POST', 'login', ['username' => 'alice', 'password' => 'alice123']);
        $r = api('GET', "share_state&map_id=$mapId");
        eq(count($r['data']['claims']), 1);
        eq($r['data']['claims'][0]['name'], 'Bob');
        eq($r['data']['claims'][0]['rights'], 'read');
    });
    it('alice revokes the link, bob keeps existing access', function () use ($mapId) {
        api('POST', 'share_revoke_link', ['map_id' => $mapId]);
        $r = api('GET', "share_state&map_id=$mapId");
        eq($r['data']['share']['active'], false);
        reset_session();
        api('POST', 'login', ['username' => 'bob', 'password' => 'bob1234']);
        $r = api('GET', "map&id=$mapId");
        eq($r['code'], 200);
        eq($r['data']['map']['access'], 'read');
    });
    it('alice flips link to write + regenerate; old token dead, new works', function () use ($mapId) {
        reset_session();
        api('POST', 'login', ['username' => 'alice', 'password' => 'alice123']);
        $r = api('POST', 'share_regenerate', ['map_id' => $mapId, 'rights' => 'write']);
        $newToken = $r['data']['token'];
        truthy($newToken !== $GLOBALS['_token'], 'new token differs');
        $r = api('GET', 'share_info&token=' . $GLOBALS['_token']);
        eq($r['code'], 404);
        $r = api('GET', 'share_info&token=' . $newToken);
        eq($r['code'], 200);
        eq($r['data']['rights'], 'write');
    });
    it('share_leave removes own claim', function () use ($mapId) {
        reset_session();
        api('POST', 'login', ['username' => 'bob', 'password' => 'bob1234']);
        api('POST', 'share_leave', ['map_id' => $mapId]);
        $r = api('GET', 'maps');
        eq(count($r['data']['shared']), 0);
        $r = api('GET', "map&id=$mapId");
        eq($r['code'], 404);
    });
});

exit(summary_exit());
