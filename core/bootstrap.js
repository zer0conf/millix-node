import fs from 'fs';
import config, {
    DATA_BASE_DIR_TEST_NETWORK, DATA_BASE_DIR_MAIN_NETWORK,
    NODE_INITIAL_LIST_MAIN_NETWORK, NODE_INITIAL_LIST_TEST_NETWORK,
    NODE_PORT_MAIN_NETWORK, NODE_PORT_TEST_NETWORK,
    NODE_PORT_DISCOVERY_MAIN_NETWORK, NODE_PORT_DISCOVERY_TEST_NETWORK,
    WALLET_TRANSACTION_DEFAULT_VERSION_MAIN_NETWORK, WALLET_TRANSACTION_DEFAULT_VERSION_TEST_NETWORK,
    WALLET_TRANSACTION_REFRESH_VERSION_MAIN_NETWORK, WALLET_TRANSACTION_REFRESH_VERSION_TEST_NETWORK,
    WALLET_TRANSACTION_SUPPORTED_VERSION_MAIN_NETWORK, WALLET_TRANSACTION_SUPPORTED_VERSION_TEST_NETWORK
} from './config/config';

import genesisConfig, {
    GENESIS_SHARD_ID_MAIN_NETWORK, GENESIS_SHARD_ID_TEST_NETWORK,
    GENESIS_TRANSACTION_MAIN_NETWORK, GENESIS_TRANSACTION_TEST_NETWORK
} from './genesis/genesis-config';


class _Bootstrap {
    constructor() {
    }

    updateBootstrapConfig(bootstrapConfig) {
        return new Promise((resolve, reject) => {
            fs.writeFile('./bootstrap.json', JSON.stringify(bootstrapConfig, null, '\t'), 'utf8', function(err) {
                if (err) {
                    return reject('failed to write the bootstrap configuration file');
                }
                resolve();
            });
        });
    }

    _resetConfigs(isModeTestNetwork) {
        if (isModeTestNetwork === undefined) {
            return;
        }

        config['MODE_TEST_NETWORK']                    = isModeTestNetwork;
        config['NODE_PORT']                            = isModeTestNetwork ? NODE_PORT_TEST_NETWORK : NODE_PORT_MAIN_NETWORK;
        config['NODE_PORT_DISCOVERY']                  = isModeTestNetwork ? NODE_PORT_DISCOVERY_TEST_NETWORK : NODE_PORT_DISCOVERY_MAIN_NETWORK;
        config['NODE_INITIAL_LIST']                    = isModeTestNetwork ? NODE_INITIAL_LIST_TEST_NETWORK : NODE_INITIAL_LIST_MAIN_NETWORK;
        config['WALLET_TRANSACTION_DEFAULT_VERSION']   = isModeTestNetwork ? WALLET_TRANSACTION_DEFAULT_VERSION_TEST_NETWORK : WALLET_TRANSACTION_DEFAULT_VERSION_MAIN_NETWORK;
        config['WALLET_TRANSACTION_REFRESH_VERSION']   = isModeTestNetwork ? WALLET_TRANSACTION_REFRESH_VERSION_TEST_NETWORK : WALLET_TRANSACTION_REFRESH_VERSION_MAIN_NETWORK;
        config['WALLET_TRANSACTION_SUPPORTED_VERSION'] = isModeTestNetwork ? WALLET_TRANSACTION_SUPPORTED_VERSION_TEST_NETWORK : WALLET_TRANSACTION_SUPPORTED_VERSION_MAIN_NETWORK;
        let DATA_BASE_DIR                              = isModeTestNetwork ? DATA_BASE_DIR_TEST_NETWORK : DATA_BASE_DIR_MAIN_NETWORK;
        config['NODE_KEY_PATH']                        = DATA_BASE_DIR + '/node.json';
        config['WALLET_KEY_PATH']                      = DATA_BASE_DIR + '/millix_private_key.json';
        config['JOB_CONFIG_PATH']                      = DATA_BASE_DIR + '/job.json';
        config['NODE_CERTIFICATE_KEY_PATH']            = DATA_BASE_DIR + '/node_certificate_key.pem';
        config['NODE_CERTIFICATE_PATH']                = DATA_BASE_DIR + '/node_certificate.pem';

        if (config.DATABASE_ENGINE === 'sqlite') {
            config['DATABASE_CONNECTION'].FOLDER = DATA_BASE_DIR + '/';
        }

        genesisConfig['genesis_transaction'] = isModeTestNetwork ? GENESIS_TRANSACTION_TEST_NETWORK : GENESIS_TRANSACTION_MAIN_NETWORK;
        genesisConfig['genesis_shard_id']    = isModeTestNetwork ? GENESIS_SHARD_ID_TEST_NETWORK : GENESIS_SHARD_ID_MAIN_NETWORK;
    }

    initialize() {
        return new Promise(resolve => {
            fs.readFile('./bootstrap.json', 'utf8', (err, data) => {
                if (err) {
                    return this.updateBootstrapConfig({MODE_TEST_NETWORK: config.MODE_TEST_NETWORK})
                               .then(() => resolve())
                               .catch(() => resolve());
                }
                try {
                    this._resetConfigs(JSON.parse(data).MODE_TEST_NETWORK);
                }
                catch (e) {
                }
                resolve();
            });
        });
    }
}


export default new _Bootstrap();
