<?php
require_once __DIR__ . '/../bootstrap.php';

$operator = current_operator();
if ($operator === null) {
    json_response(['operator' => null]);
}

json_response(['operator' => $operator, 'csrf_token' => csrf_token()]);
