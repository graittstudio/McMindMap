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
