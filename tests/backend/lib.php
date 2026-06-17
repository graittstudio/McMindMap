<?php
// Tiny test harness: api() drives the live api/index.php via curl, holding
// the session cookie + CSRF token across calls so tests can chain. it() /
// describe() count pass/fail. No external dependencies on purpose -- this
// is meant to run on the same shell runner that already has PHP for lint.
declare(strict_types=1);

$GLOBALS['_ctx'] = [
    'base'    => getenv('API_BASE') ?: 'http://127.0.0.1:8000/api/index.php',
    'cookies' => [],
    'csrf'    => '',
    'pass'    => 0,
    'fail'    => 0,
];

function api(string $method, string $action, ?array $body = null): array {
    $ctx =& $GLOBALS['_ctx'];
    $ch = curl_init($ctx['base'] . '?action=' . $action);
    $hdrs = [];
    if ($body !== null) {
        $hdrs[] = 'Content-Type: application/json';
        if ($ctx['csrf']) $hdrs[] = 'X-CSRF-Token: ' . $ctx['csrf'];
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
    }
    if ($ctx['cookies']) {
        $jar = [];
        foreach ($ctx['cookies'] as $k => $v) $jar[] = "$k=$v";
        curl_setopt($ch, CURLOPT_COOKIE, implode('; ', $jar));
    }
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST  => $method,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HEADER         => true,
        CURLOPT_HTTPHEADER     => $hdrs,
        CURLOPT_TIMEOUT        => 5,
    ]);
    $resp = curl_exec($ch);
    if ($resp === false) throw new RuntimeException("curl: " . curl_error($ch));
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $hsz  = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    $hdr  = substr($resp, 0, $hsz);
    $bdy  = substr($resp, $hsz);
    curl_close($ch);
    if (preg_match_all('/^Set-Cookie:\s*([^=]+)=([^;]*)/mi', $hdr, $m)) {
        foreach ($m[1] as $i => $k) $ctx['cookies'][trim($k)] = $m[2][$i];
    }
    $data = json_decode($bdy, true);
    if (!is_array($data)) $data = [];
    if (isset($data['csrf'])) $ctx['csrf'] = $data['csrf'];
    return ['code' => $code, 'data' => $data];
}

function reset_session(): void {
    $GLOBALS['_ctx']['cookies'] = [];
    $GLOBALS['_ctx']['csrf']    = '';
}

function describe(string $title, callable $fn): void {
    echo "\n  \033[1m▸ $title\033[0m\n";
    $fn();
}

function it(string $name, callable $fn): void {
    try {
        $fn();
        echo "    \033[32m✓\033[0m $name\n";
        $GLOBALS['_ctx']['pass']++;
    } catch (Throwable $e) {
        echo "    \033[31m✗\033[0m $name\n      " . $e->getMessage() . "\n";
        $GLOBALS['_ctx']['fail']++;
    }
}

function eq($actual, $expected, string $msg = ''): void {
    if ($actual !== $expected) {
        throw new RuntimeException(($msg ? "$msg: " : '') .
            'expected ' . json_encode($expected) . ', got ' . json_encode($actual));
    }
}

function truthy($v, string $msg = ''): void {
    if (!$v) throw new RuntimeException(($msg ? "$msg: " : '') . 'expected truthy, got ' . json_encode($v));
}

function summary_exit(): int {
    $c = $GLOBALS['_ctx'];
    echo "\n";
    if ($c['fail']) {
        echo "  \033[31m" . $c['fail'] . " failing\033[0m, " . $c['pass'] . " passing\n\n";
        return 1;
    }
    echo "  \033[32m" . $c['pass'] . " passing\033[0m\n\n";
    return 0;
}
