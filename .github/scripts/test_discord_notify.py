import contextlib
import io
import json
import os
from pathlib import Path
import runpy
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).with_name('discord_notify.py')
REPO_URL = 'https://github.com/xBandaku/TwitchAdSolutions'


class NotificationTests(unittest.TestCase):
    def render(self, github_event, action, payload, override=None):
        with TemporaryDirectory() as temp:
            original = Path(temp) / 'github-event.json'
            original.write_text(json.dumps(payload), encoding='utf-8')
            env = {
                'GITHUB_EVENT_NAME': github_event,
                'GITHUB_EVENT_ACTION': action,
                'GITHUB_EVENT_PATH': str(original),
                'GITHUB_REPOSITORY': 'xBandaku/TwitchAdSolutions',
                'GITHUB_ACTOR': 'fixture',
                'DISCORD_WEBHOOK_URL': 'https://example.invalid/webhook',
            }
            if override:
                notification = Path(temp) / 'notification-event.json'
                notification.write_text(json.dumps(override['payload']), encoding='utf-8')
                env.update({
                    'NOTIFICATION_EVENT_NAME': override['name'],
                    'NOTIFICATION_EVENT_ACTION': override['action'],
                    'NOTIFICATION_EVENT_PATH': str(notification),
                })
            response = unittest.mock.MagicMock()
            response.__enter__.return_value.status = 204
            with patch.dict(os.environ, env, clear=True), \
                    patch('urllib.request.urlopen', return_value=response) as send, \
                    contextlib.redirect_stdout(io.StringIO()):
                runpy.run_path(str(SCRIPT), run_name='__main__')
            self.assertEqual(send.call_count, 1)
            request = send.call_args.args[0]
            self.assertEqual(request.get_method(), 'POST')
            result = json.loads(request.data)
            self.assertEqual(result['allowed_mentions'], {'parse': []})
            return result['embeds'][0]

    def test_release_override_uses_release_payload_with_reserved_github_defaults(self):
        release = {
            'name': 'Release v68.5.29',
            'tag_name': 'v68.5.29',
            'html_url': REPO_URL + '/releases/tag/v68.5.29',
            'body': 'Compact notification cards.',
            'assets': [{
                'name': 'vaft.user.js',
                'browser_download_url': REPO_URL + '/releases/download/v68.5.29/vaft.user.js',
            }],
        }
        embed = self.render('workflow_dispatch', '', {'inputs': {'dry_run': False}}, {
            'name': 'release', 'action': 'published',
            'payload': {'action': 'published', 'release': release},
        })
        self.assertEqual(embed['title'], release['name'])
        self.assertEqual(embed['url'], release['html_url'])
        self.assertIn(release['body'], embed['description'])
        self.assertIn('vaft.user.js', embed['fields'][0]['value'])
        self.assertNotIn('connected', embed['title'])

    def test_only_closed_merged_pull_requests_are_announced_as_merged(self):
        pr = {'merged': True, 'number': 31, 'title': 'Notification layout',
              'html_url': REPO_URL + '/pull/31'}
        for action, expected in [('closed', 'Merged'), ('edited', 'Edited'), ('labeled', 'Labeled')]:
            with self.subTest(action=action):
                embed = self.render('pull_request', action, {'pull_request': pr})
                self.assertEqual(embed['description'], f'**{expected}**')
                self.assertEqual(embed['color'], 0xA371F7)

    def test_closed_unmerged_pull_request_is_closed(self):
        embed = self.render('pull_request', 'closed', {
            'pull_request': {'merged': False, 'number': 32, 'title': 'Unmerged change'},
        })
        self.assertEqual(embed['description'], '**Closed**')
        self.assertEqual(embed['color'], 0xF85149)

    def test_plain_manual_dispatch_remains_a_connection_preview(self):
        embed = self.render('workflow_dispatch', '', {})
        self.assertEqual(embed['title'], 'GitHub notifications are connected')


if __name__ == '__main__':
    unittest.main()
