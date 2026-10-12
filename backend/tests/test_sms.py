import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app import sms


class SmsDeliveryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        sms.reset_for_tests()
        self.previous = {name: os.environ.get(name) for name in (
            "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER",
            "Kabil_number", "Monesh_number",
        )}

    def tearDown(self):
        sms.reset_for_tests()
        for name, value in self.previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value

    def configure(self):
        os.environ.update({
            "TWILIO_ACCOUNT_SID": "AC00000000000000000000000000000000",
            "TWILIO_AUTH_TOKEN": "test-token",
            "TWILIO_PHONE_NUMBER": "+15551234567",
            "Kabil_number": "+919876543210",
            "Monesh_number": "+919876543211",
        })

    async def test_missing_credentials_is_reported_without_client(self):
        for name in ("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"):
            os.environ.pop(name, None)
        with patch("twilio.rest.Client") as client:
            result = await sms.send_announcement("Test alert", 1)
        self.assertEqual(result["status"], "failed")
        self.assertFalse(result["configured"])
        client.assert_not_called()

    async def test_each_recipient_is_submitted_once(self):
        self.configure()
        created = []

        def create(**kwargs):
            created.append(kwargs)
            return SimpleNamespace(sid=f"SM{len(created)}", status="queued")

        with patch("twilio.rest.Client") as client:
            client.return_value.messages.create.side_effect = create
            result = await sms.send_announcement("Evacuate now", 2)
            duplicate = await sms.send_announcement("Evacuate now", 2)

        self.assertEqual(result["status"], "accepted")
        self.assertEqual(duplicate, result)
        self.assertEqual(len(created), 2)
        self.assertEqual([item["body"] for item in created], ["Evacuate now", "Evacuate now"])
        self.assertEqual([item["to"] for item in created], ["+919876543210", "+919876543211"])

    async def test_invalid_one_recipient_does_not_hide_other_result(self):
        self.configure()
        os.environ["Kabil_number"] = "not-a-phone"
        with patch("twilio.rest.Client") as client:
            client.return_value.messages.create.return_value = SimpleNamespace(sid="SM-valid", status="queued")
            result = await sms.send_announcement("Status update", 3)
        by_name = {item["recipient"]: item for item in result["results"]}
        self.assertEqual(by_name["Kabil"]["status"], "failed")
        self.assertEqual(by_name["Monesh"]["status"], "accepted")
