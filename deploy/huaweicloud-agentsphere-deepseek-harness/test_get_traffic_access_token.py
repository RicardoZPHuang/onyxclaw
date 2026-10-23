import contextlib
import io
import json
import os
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError, URLError

import get_traffic_access_token as helper


class TokenHelperTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {
            "E2B_API_KEY": "test-api-key",
            "E2B_API_URL": "https://control.example.test",
        }, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def invoke(self, response=None, args=None, error=None):
        opener = Mock()
        if error is not None:
            opener.open.side_effect = error
        else:
            opener.open.return_value = io.BytesIO(json.dumps(response).encode())
        out, err = io.StringIO(), io.StringIO()
        with patch.object(helper, "build_opener", return_value=opener), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = helper.main(args if args is not None else ["sandbox-123"])
        return code, out.getvalue(), err.getvalue(), opener

    def test_default_outputs_both_tokens_without_parsing_envd_version(self):
        response = {"trafficAccessToken": "traffic-test", "envdAccessToken": "envd-test", "envdVersion": ""}
        code, out, err, opener = self.invoke(response)
        self.assertEqual(code, 0)
        self.assertEqual(err, "")
        self.assertEqual(json.loads(out), {
            "sandboxID": "sandbox-123", "trafficAccessToken": "traffic-test", "envdAccessToken": "envd-test",
        })
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, "https://control.example.test/sandboxes/sandbox-123/connect")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.get_header("X-api-key"), "test-api-key")
        self.assertEqual(json.loads(request.data), {"timeout": 300})
        self.assertEqual(opener.open.call_args.kwargs["timeout"], 30)

    def test_snake_case_response_fields_are_supported(self):
        code, out, err, _ = self.invoke({"traffic_access_token": " traffic ", "envd_access_token": " envd "})
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(json.loads(out)["envdAccessToken"], "envd")

    def test_single_token_modes_keep_legacy_output(self):
        for fmt, response, expected in [
            ("traffic", {"trafficAccessToken": "traffic-only"}, "traffic-only\n"),
            ("envd", {"envdAccessToken": "envd-only"}, "envd-only\n"),
        ]:
            with self.subTest(format=fmt):
                code, out, err, _ = self.invoke(response, ["sandbox-123", "--format", fmt])
                self.assertEqual((code, out, err), (0, expected, ""))

    def test_missing_or_invalid_token_never_prints_partial_credentials(self):
        for missing, response in [
            ("envdAccessToken", {"trafficAccessToken": "traffic-secret"}),
            ("trafficAccessToken", {"envdAccessToken": "envd-secret"}),
            ("envdAccessToken", {"trafficAccessToken": "traffic-secret", "envdAccessToken": 42}),
        ]:
            with self.subTest(response=response):
                code, out, err, _ = self.invoke(response)
                self.assertEqual(code, 1)
                self.assertEqual(out, "")
                self.assertIn(missing, err)
                self.assertNotIn("traffic-secret", err)
                self.assertNotIn("envd-secret", err)

    def test_nonstandard_401_preserves_diagnostic_and_redacts_api_key(self):
        error = HTTPError("https://control.example.test", 401, "Unauthorized", {}, io.BytesIO(
            b'{"error_code":"Sandbox.401001","detail":"not in subscribe whitelist test-api-key"}',
        ))
        code, out, err, _ = self.invoke(error=error)
        self.assertEqual((code, out), (1, ""))
        self.assertIn("HTTP 401", err)
        self.assertIn("not in subscribe whitelist", err)
        self.assertNotIn("test-api-key", err)

    def test_network_failure_has_no_token_output(self):
        code, out, err, _ = self.invoke(error=URLError("unreachable"))
        self.assertEqual((code, out), (1, ""))
        self.assertIn("unreachable", err)

    def test_non_object_response_fails_cleanly(self):
        code, out, err, _ = self.invoke(["unexpected"])
        self.assertEqual((code, out), (1, ""))
        self.assertIn("invalid response object", err)

    def test_invalid_json_fails_cleanly(self):
        opener = Mock()
        opener.open.return_value = io.BytesIO(b"<html>not JSON</html>")
        with patch.object(helper, "build_opener", return_value=opener):
            with self.assertRaisesRegex(ValueError, "invalid JSON"):
                helper.connect_sandbox("https://control.example.test", "sandbox", "key", 30)

    def test_sandbox_environment_and_cli_api_override(self):
        os.environ["E2B_SANDBOX_ID"] = "sandbox/with space"
        code, _, _, opener = self.invoke(
            {"trafficAccessToken": "traffic", "envdAccessToken": "envd"},
            ["--api-url", "https://override.example.test/prefix/", "--request-timeout", "12"],
        )
        self.assertEqual(code, 0)
        self.assertEqual(opener.open.call_args.args[0].full_url,
                         "https://override.example.test/prefix/sandboxes/sandbox%2Fwith%20space/connect")
        self.assertEqual(opener.open.call_args.kwargs["timeout"], 12)

    def test_invalid_arguments_do_not_make_requests(self):
        for args in [
            ["sandbox", "--api-url", "https://user:pass@host"],
            ["sandbox", "--api-url", "https://host?query=1"],
            ["sandbox", "--request-timeout", "nan"],
            ["sandbox", "--request-timeout", "0"],
            [],
        ]:
            with self.subTest(args=args), patch.object(helper, "build_opener") as opener:
                with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                    helper.main(args)
                opener.assert_not_called()

if __name__ == "__main__":
    unittest.main()
