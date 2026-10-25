const { DistributionAPI } = require('helios-core/common')

const ConfigManager = require('./configmanager')

// Old WesterosCraft url.
// exports.REMOTE_DISTRO_URL = 'http://mc.westeroscraft.com/WesterosCraftLauncher/distribution.json'
// Old GitHub-hosted url (25~30MB 업로드 한도 때문에 Cloudflare Worker+R2로 옮김, tools/distro-worker 참고).
// exports.REMOTE_DISTRO_URL = 'https://raw.githubusercontent.com/hanol0927/ddumon/main/distribution.json'
exports.REMOTE_DISTRO_URL = 'https://cyml-distro-worker.chaenna02.workers.dev/distribution.json'

const api = new DistributionAPI(
    ConfigManager.getLauncherDirectory(),
    null, // Injected forcefully by the preloader.
    null, // Injected forcefully by the preloader.
    exports.REMOTE_DISTRO_URL,
    false
)

exports.DistroAPI = api