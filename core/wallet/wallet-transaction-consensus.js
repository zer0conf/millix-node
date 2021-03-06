import database from '../../database/database';
import eventBus from '../event-bus';
import network from '../../net/network';
import peer from '../../net/peer';
import genesisConfig from '../genesis/genesis-config';
import config from '../config/config';
import async from 'async';
import _ from 'lodash';
import wallet from './wallet';
import ntp from '../ntp';


export class WalletTransactionConsensus {

    constructor() {
        this._transactionValidationState    = {
            /*[ws.nodeID]: {
             transaction_id: id,
             timestamp: int
             }*/
        };
        this._consensusRoundState           = {
            /*[transaction.transaction_id]: {
             consensus_round_validation_count  : int,
             consensus_round_double_spend_count: int,
             consensus_round_not_found_count   : int,
             consensus_round_count             : int,
             consensus_round_response: array,
             timestamp: int,
             resolve : func,
             active  : bool
             }*/
        };
        this._transactionValidationRejected = new Set();
        this._validationPrepareState        = {
            /*[transaction.transaction_id] : {
             transaction_not_found_count: int
             }*/
        };
        this._transactionRetryValidation    = new Set();
        this._transactionValidationNotFound = new Set();
        this._transactionObjectCache        = {};
    }

    initialize() {
        return Promise.resolve();
    }

    addTransactionToCache(transaction) {
        this._transactionObjectCache[transaction.transaction_id] = transaction;
    }

    deleteTransactionFromCache(transactionID) {
        delete this._transactionObjectCache[transactionID];
    }

    getRejectedTransactionList() {
        return this._transactionValidationRejected;
    }

    getRetryTransactionList() {
        return this._transactionRetryValidation;
    }

    removeFromRetryTransactions(transactionID) {
        delete this._transactionRetryValidation[transactionID];
    }

    removeFromRejectedTransactions(transactionID) {
        delete this._transactionValidationRejected.delete(transactionID);
    }

    resetTransactionValidationRejected() {
        this._transactionValidationRejected = new Set();
    }

    _mapToAuditPointDistance(inputs) {
        return new Promise(resolve => {
            async.mapSeries(inputs, (input, callback) => {
                database.getRepository('transaction')
                        .getTransactionMinDistance(input.transaction_id, genesisConfig.genesis_transaction)
                        .then(distance => {
                            callback(null, {
                                input,
                                distance
                            });
                        });
            }, (err, results) => {
                console.log('[consensus][oracle] double spent check distance is ', results);
                resolve(results);
            });
        });
    }

    _getValidInputOnDoubleSpend(doubleSpendTransactionID, inputs, nodeID, transactionVisitedSet, doubleSpendSet) {
        return new Promise(resolve => {
            let responseType = 'transaction_double_spend';
            let responseData = null;
            async.eachSeries(inputs, (input, callback) => {
                database.firstShardZeroORShardRepository('transaction', input.shard_id, transactionRepository => {
                    return new Promise((resolve, reject) => {
                        transactionRepository.getTransaction(input.transaction_id)
                                             .then(transaction => transaction ? resolve(transaction) : reject()).catch(reject);
                    });
                }).then(transaction => {
                    transaction = transaction || this._transactionObjectCache[input.transaction_id];
                    if (!transaction) {
                        responseType = 'transaction_not_found';
                        responseData = {transaction_id: input.transaction_id};
                        return callback(true);
                    }
                    else if (!doubleSpendSet.has(transaction.transaction_id) && (!responseData || transaction.transaction_date < responseData.transaction_date
                                                                                 || ((transaction.transaction_date.getTime() === responseData.transaction_date.getTime()) && (transaction.transaction_id < responseData.transaction_id)))) {

                        let newVisitedTransactionSet = new Set(transactionVisitedSet);
                        newVisitedTransactionSet.add(doubleSpendTransactionID);
                        this._validateTransaction(transaction.transaction_id, nodeID, 0, newVisitedTransactionSet, doubleSpendSet)
                            .then(() => {
                                responseType = 'transaction_valid';
                                responseData = transaction;
                                callback();
                            })
                            .catch(err => {
                                if (err.cause === 'transaction_double_spend') {
                                    doubleSpendSet.add(transaction.transaction_id);
                                    return callback();
                                }
                                else if (err.cause === 'transaction_not_found') {
                                    responseType = 'transaction_not_found';
                                    responseData = {transaction_id: err.transaction_id_fail};
                                }
                                else {
                                    responseType = 'transaction_double_spend_unresolved';
                                    responseData = {transaction_id: transaction.transaction_id};
                                }
                                callback(true);
                            });
                    }
                    else {
                        callback();
                    }
                }).catch(() => callback());
            }, () => resolve({
                response_type: responseType,
                data         : responseData
            }));
        });
    }

    _setAsDoubleSpend(transactions, doubleSpendTransaction) {
        console.log('[consensus][oracle] setting ', transactions.length, ' transaction as double spend');
        async.eachSeries(transactions, (transaction, callback) => database.firstShards((shardID) => {
            return new Promise((resolve, reject) => {
                const transactionRepository = database.getRepository('transaction', shardID);
                transactionRepository.getTransactionObject(transaction.transaction_id)
                                     .then(transaction => transaction ? transactionRepository.setTransactionAsDoubleSpend(transaction, doubleSpendTransaction).then(() => resolve())
                                                                      : reject());
            });
        }).then(() => callback()));
    }

    _validateTransaction(transaction, nodeID, depth = 0, transactionVisitedSet = new Set(), doubleSpendSet = new Set()) {
        let transactionID;
        if (typeof (transaction) === 'object') {
            transactionID = transaction.transaction_id;
        }
        else {
            transactionID = transaction;
            transaction   = null;
        }

        return new Promise((resolve, reject) => {
            (() => transaction ? Promise.resolve([
                transaction,
                transaction.shard_id
            ]) : database.firstShards((shardID) => {
                return new Promise((resolve, reject) => {
                    const transactionRepository = database.getRepository('transaction', shardID);
                    transactionRepository.getTransactionObject(transactionID)
                                         .then(transaction => transaction ? resolve([
                                             transactionRepository.normalizeTransactionObject(transaction),
                                             shardID
                                         ]) : reject());
                });
            }))().then(data => {
                const [transaction, shardID] = data || [];
                if (!transaction) {
                    return [];
                }
                return database.getRepository('audit_point', shardID)
                               .getAuditPoint(transactionID)
                               .then(auditPoint => [
                                   transaction,
                                   auditPoint ? auditPoint.audit_point_id : undefined
                               ]);
            }).then(([transaction, auditPointID]) => {

                if (transaction && transaction.is_stable && _.every(transaction.transaction_output_list, output => output.is_stable && !output.is_double_spend)) {
                    console.log('[consensus][oracle] validated in consensus round after found a validated transaction at depth ', depth);
                    return resolve();
                }
                else if (auditPointID) {
                    console.log('[consensus][oracle] validated in consensus round after found in Local audit point ', auditPointID, ' at depth ', depth);
                    return resolve();
                }
                else if (!transaction) {
                    return reject({
                        cause              : 'transaction_not_found',
                        transaction_id_fail: transactionID,
                        message            : 'no information found for ' + transactionID
                    });
                }
                else if (transaction.transaction_id === genesisConfig.genesis_transaction) {
                    return resolve();
                }
                else if (depth === config.CONSENSUS_VALIDATION_REQUEST_DEPTH_MAX) {
                    return reject({
                        cause              : 'transaction_validation_max_depth',
                        transaction_id_fail: transactionID,
                        message            : `not validated in a depth of ${depth}`
                    });
                }
                else if (doubleSpendSet.has(transactionID)) {
                    return reject({
                        cause              : 'transaction_double_spend',
                        transaction_id_fail: transactionID,
                        message            : 'double spend found in ' + transactionID
                    });
                }
                else if (transactionVisitedSet.has(transactionID)) {
                    return resolve();
                }

                transactionVisitedSet.add(transactionID);

                let sourceTransactions = new Set();
                let inputTotalAmount   = 0;
                // get inputs and check double
                // spend
                async.everySeries(transaction.transaction_input_list, (input, callback) => {
                    if (doubleSpendSet.has(input.output_transaction_id)) {
                        return callback({
                            cause              : 'transaction_double_spend',
                            transaction_id_fail: input.output_transaction_id,
                            message            : 'double spend found in ' + input.output_transaction_id
                        }, false);
                    }

                    (() => {
                        if (!transactionVisitedSet.has(input.output_transaction_id)) {
                            sourceTransactions.add(input.output_transaction_id);
                            return database.applyShards((shardID) => database.getRepository('transaction', shardID).getInputDoubleSpend(input, transaction.transaction_id)).then(data => data || []);
                        }
                        else {
                            return Promise.resolve([]);
                        }
                    })().then(doubleSpendTransactions => {
                        return new Promise((resolve, reject) => {
                            if (doubleSpendTransactions.length > 0) {
                                doubleSpendTransactions.push({
                                    transaction_id: transaction.transaction_id,
                                    shard_id      : transaction.shard_id,
                                    ...input
                                });
                                this._getValidInputOnDoubleSpend(input.output_transaction_id, doubleSpendTransactions, nodeID, transactionVisitedSet, doubleSpendSet)
                                    .then(({response_type: responseType, data}) => {

                                        if ((responseType === 'transaction_double_spend' && !data) ||
                                            (responseType === 'transaction_valid' && data.transaction_id !== transaction.transaction_id)) {
                                            return reject({
                                                cause              : 'transaction_double_spend',
                                                transaction_id_fail: input.output_transaction_id,
                                                message            : 'double spend found in ' + input.output_transaction_id
                                            });
                                        }
                                        else if (responseType === 'transaction_not_found') {
                                            return reject({
                                                cause              : 'transaction_not_found',
                                                transaction_id_fail: data.transaction_id,
                                                message            : 'no information found for ' + data.transaction_id
                                            });
                                        }
                                        else if (responseType === 'transaction_double_spend_unresolved') {
                                            return reject({
                                                cause              : 'transaction_double_spend_unresolved',
                                                transaction_id_fail: data.transaction_id,
                                                message            : 'unresolved double spend. unknown state of transaction id ' + data.transaction_id
                                            });
                                        }


                                        let doubleSpendInputs = _.filter(doubleSpendTransactions, i => i.transaction_id !== data.transaction_id);
                                        doubleSpendInputs.forEach(doubleSpendInput => doubleSpendSet.add(doubleSpendInput.transaction_id));
                                        this._setAsDoubleSpend(doubleSpendInputs, input.output_transaction_id);
                                        resolve();
                                    });
                            }
                            else {
                                resolve();
                            }
                        });
                    }).then(() => {
                        // get
                        // the
                        // total
                        // millix
                        // amount
                        // of
                        // this
                        // input
                        database.firstShards((shardID) => {
                            return new Promise((resolve, reject) => {
                                const transactionRepository = database.getRepository('transaction', shardID);
                                transactionRepository.getOutput(input.output_transaction_id, input.output_position)
                                                     .then(output => output ? resolve(output) : reject());
                            });
                        }).then(output => {
                            if (!output) {
                                return callback({
                                    cause              : 'transaction_not_found',
                                    transaction_id_fail: input.output_transaction_id,
                                    message            : 'no information found for ' + input.output_transaction_id
                                }, false);
                            }
                            inputTotalAmount += output.amount;
                            return callback(null, true);
                        }).catch(() => {
                            return callback({
                                cause              : 'peer_error',
                                transaction_id_fail: transactionID,
                                message            : 'generic database error when getting data for transaction id ' + input.output_transaction_id
                            }, false);
                        });
                    }).catch(err => {
                        callback(err, false);
                    });
                }, (err, valid) => {
                    if (err && !valid) { //not valid
                        return reject(err);
                    }

                    if (nodeID && (!this._transactionValidationState[nodeID] || (Date.now() - this._transactionValidationState[nodeID].timestamp) >= config.CONSENSUS_VALIDATION_WAIT_TIME_MAX)) { //timeout has been triggered
                        return reject({
                            cause: 'consensus_timeout',
                            depth
                        });
                    }

                    // compare input and output
                    // amount
                    let outputTotalAmount = 0;
                    _.each(transaction.transaction_output_list, output => {
                        outputTotalAmount += output.amount;
                    });

                    if (outputTotalAmount > inputTotalAmount) {
                        return reject({
                            cause              : 'transaction_invalid_amount',
                            transaction_id_fail: transactionID,
                            message            : 'output amount is greater than input amount in transaction id ' + transactionID
                        });
                    }


                    // check inputs transactions
                    async.everySeries(sourceTransactions, (srcTransaction, callback) => {
                        this._validateTransaction(srcTransaction, nodeID, depth + 1, transactionVisitedSet, doubleSpendSet)
                            .then(() => callback(null, true))
                            .catch((err) => callback(err, false));
                    }, (err, valid) => {
                        if (err && !valid) {
                            return reject(err);
                        }
                        resolve();
                    });

                });
            });
        });
    }

    _validateTransactionInConsensusRound(data, ws) {
        const {node, nodeID, connectionID} = ws;
        const transactionID                = data.transaction_id;

        if (!this._transactionValidationState[ws.nodeID] ||
            this._transactionValidationState[ws.nodeID].transaction_id !== data.transaction_id ||
            !!this._transactionValidationState[ws.nodeID].timestamp) {
            return peer.transactionValidationResponse({
                cause                : 'transaction_validation_unexpected',
                transaction_id_failed: transactionID,
                transaction_id       : transactionID,
                valid                : false,
                type                 : 'validation_response'
            }, ws, true);
        }

        console.log('[consensus][oracle] request received to validate transaction ', transactionID);
        eventBus.emit('wallet_event_log', {
            type   : 'transaction_validation_request',
            content: data,
            from   : node
        });

        this._transactionValidationState[nodeID]['timestamp'] = Date.now();
        this._validateTransaction(transactionID, nodeID)
            .then(() => {
                console.log('[consensus][oracle] transaction ', transactionID, ' was validated for a consensus');
                let ws = network.getWebSocketByID(connectionID);
                if (ws) {
                    peer.transactionValidationResponse({
                        transaction_id: transactionID,
                        valid         : true,
                        type          : 'validation_response'
                    }, ws, true);
                }
                delete this._transactionValidationState[nodeID];
            })
            .catch((err) => {
                console.log('[consensus][oracle] consensus error: ', err);

                delete this._transactionValidationState[nodeID];
                let ws = network.getWebSocketByID(connectionID);
                if (err.cause === 'consensus_timeout') {
                    return;
                }
                else if (err.cause === 'transaction_not_found') {
                    ws && peer.transactionSyncByWebSocket(err.transaction_id_fail, ws).then(_ => _);
                    wallet.requestTransactionFromNetwork(err.transaction_id_fail);
                }

                if (ws) {
                    peer.transactionValidationResponse({
                        ...err,
                        transaction_id: transactionID,
                        valid         : false,
                        type          : 'validation_response'
                    }, ws, true);
                }
            });

    }

    _selectNodesForConsensusRound(numberOfNodes = config.CONSENSUS_ROUND_NODE_COUNT, excludeNodeSet = new Set()) {
        return _.sampleSize(_.filter(network.registeredClients, ws => ws.nodeConnectionReady && (ws.outBound || ws.bidirectional) && !excludeNodeSet.has(ws.nodeID)), numberOfNodes);
    }

    _isNeedNodesInConsensusRound(transactionID) {
        const consensusData = this._consensusRoundState[transactionID];
        if (!consensusData || !consensusData.consensus_round_response) {
            return false;
        }

        // check if we have all answers
        const consensusNodeIDList = _.keys(consensusData.consensus_round_response[consensusData.consensus_round_count]);
        return consensusNodeIDList.length < config.CONSENSUS_ROUND_NODE_COUNT;
    }

    _startConsensusRound(transactionID) {
        return database.firstShards((shardID) => {
            return new Promise((resolve, reject) => {
                const transactionRepository = database.getRepository('transaction', shardID);
                transactionRepository.getTransactionObject(transactionID)
                                     .then(transaction => transaction ? resolve(transaction) : reject());
            });
        })
                       .then(dbTransaction => database.getRepository('transaction').normalizeTransactionObject(dbTransaction))
                       .then(transaction => {

                           if (!transaction) { // transaction data not found
                               console.warn('[wallet-transaction-consensus] transaction not found. unexpected behaviour.');
                               return Promise.reject();
                           }

                           console.log('[consensus][request]', transactionID, ' is ready for consensus round');
                           if (transactionID === genesisConfig.genesis_transaction) { // genesis transaction
                               return database.applyShardZeroAndShardRepository('transaction', transaction.shard_id, transactionRepository => {
                                   return transactionRepository.setTransactionAsStable(transactionID)
                                                               .then(() => transactionRepository.setOutputAsStable(transactionID))
                                                               .then(() => transactionRepository.setInputsAsSpend(transactionID));
                               });
                           }

                           return new Promise(resolve => {

                               const requestPeerValidation = () => {
                                   if (!this._isNeedNodesInConsensusRound(transactionID)) {
                                       return;
                                   }
                                   const consensusData     = this._consensusRoundState[transactionID];
                                   let consensusNodeIDList = [];
                                   for (let i = 0; i < consensusData.consensus_round_count + 1; i++) {
                                       consensusNodeIDList = consensusNodeIDList.concat(_.keys(consensusData.consensus_round_response[i]));
                                   }
                                   const [selectedWS] = this._selectNodesForConsensusRound(1, new Set(consensusNodeIDList));

                                   if (!selectedWS) {
                                       console.log('[consensus][request] no node ready for this consensus round');
                                       //TODO: trigger peer rotation?
                                       return setTimeout(() => requestPeerValidation(), 2500);
                                   }

                                   peer.transactionSendToNode(transaction, selectedWS);

                                   consensusData.consensus_round_response[consensusData.consensus_round_count][selectedWS.nodeID] = {response: null};
                                   peer.transactionValidationRequest({transaction_id: transactionID}, selectedWS)
                                       .then(data => {
                                           if (data.type !== 'validation_start' || this._isNeedNodesInConsensusRound(transactionID)) {
                                               requestPeerValidation();
                                           }
                                       })
                                       .catch(() => {
                                           // remove node from
                                           // consensus round
                                           if (this._consensusRoundState[transactionID]) {
                                               try {
                                                   delete this._consensusRoundState[transactionID].consensus_round_response[consensusData.consensus_round_count][selectedWS.nodeID];
                                               }
                                               catch (e) {
                                                   console.log(e);
                                               }
                                           }
                                           requestPeerValidation();
                                       });
                               };

                               requestPeerValidation();
                               this._consensusRoundState[transactionID]['transaction']           = transaction;
                               this._consensusRoundState[transactionID]['resolve']               = resolve;
                               this._consensusRoundState[transactionID]['requestPeerValidation'] = requestPeerValidation;
                           });
                       });
    }

    processTransactionValidationRequest(data, ws) {
        // deal with the allocation process

        if (_.keys(this._transactionValidationState).length >= config.CONSENSUS_VALIDATION_PARALLEL_REQUEST_MAX) {
            peer.transactionValidationResponse({
                ...data,
                type: 'node_not_available'
            }, ws);
        }
        else {
            // lock a spot in the validation queue
            this._transactionValidationState[ws.nodeID] = {transaction_id: data.transaction_id};
            peer.transactionValidationResponse({
                ...data,
                type: 'validation_start'
            }, ws);

            this._validateTransactionInConsensusRound(data, ws);
        }
    }

    _nextConsensusRound(transactionID) {
        const consensusData = this._consensusRoundState[transactionID];
        if (consensusData.consensus_round_count === config.CONSENSUS_ROUND_VALIDATION_MAX - 1) {
            consensusData.active = false;
            this._transactionValidationRejected.add(transactionID);
            consensusData.resolve();
        }
        else {
            consensusData.consensus_round_count++;
            consensusData.consensus_round_response[consensusData.consensus_round_count] = {};
            consensusData.timestamp                                                     = Date.now();
            consensusData.requestPeerValidation();
        }
    }

    processTransactionValidationResponse(data, ws) {
        const transactionID = data.transaction_id;
        const consensusData = this._consensusRoundState[transactionID];
        if (!ws || !consensusData || !consensusData.consensus_round_response || !consensusData.consensus_round_response[consensusData.consensus_round_count][ws.nodeID] || !consensusData.active) {
            return;
        }

        console.log('[consensus][request] received reply for this consensus round from ', ws.node);

        eventBus.emit('wallet_event_log', {
            type   : 'transaction_validation_response',
            content: data,
            from   : ws.node
        });

        if (data.valid === false && ![
            'transaction_double_spend',
            'transaction_not_found',
            'transaction_invalid_amount',
            'transaction_validation_max_depth'
        ].includes(data.cause)) {
            delete this._consensusRoundState[transactionID].consensus_round_response[consensusData.consensus_round_count][ws.nodeID];
            this._consensusRoundState[transactionID].requestPeerValidation();
            return;
        }
        else if (data.cause === 'transaction_not_found') {
            return database.firstShards((shardID) => {
                return new Promise((resolve, reject) => {
                    const transactionRepository = database.getRepository('transaction', shardID);
                    transactionRepository.getTransactionObject(data.transaction_id_fail)
                                         .then(transaction => transaction ? resolve(transactionRepository.normalizeTransactionObject(transaction)) : reject());
                });
            }).then(transaction => {
                if (!transaction) {
                    peer.transactionSyncRequest(data.transaction_id_fail, {dispatch_request: true}).then(_ => _).catch(_ => _);
                    return;
                }
                peer.transactionSendToNode(transaction, ws);
            });
        }

        const consensusResponseData      = this._consensusRoundState[transactionID].consensus_round_response[consensusData.consensus_round_count];
        consensusResponseData[ws.nodeID] = {response: data};

        if (_.keys(consensusResponseData).length < config.CONSENSUS_ROUND_NODE_COUNT) {
            return;
        }

        // check if we have all responses
        let counter = {
            valid       : 0,
            double_spend: 0,
            not_found   : 0
        };

        for (let [_, {response}] of Object.entries(consensusResponseData)) {
            if (!response) {
                return;
            }
            if (response.valid === true) {
                counter.valid++;
            }
            else if (response.cause === 'transaction_double_spend') {
                counter.double_spend++;
            }
            else if (response.cause === 'transaction_not_found') {
                counter.not_found++;
            }
        }

        // check consensus result
        const responseCount = _.keys(consensusResponseData).length;
        const isValid       = counter.valid >= 2 / 3 * responseCount;
        const transaction   = consensusData.transaction;
        if (!isValid) {
            console.log('[consensus][request] the transaction ', transactionID, ' was not validated during consensus round number', consensusData.consensus_round_count);
            let isDoubleSpend = counter.double_spend >= 2 / 3 * responseCount;
            let isNotFound    = counter.not_found >= 2 / 3 * responseCount;
            if (isDoubleSpend) {
                consensusData.consensus_round_double_spend_count++;
                if (consensusData.consensus_round_double_spend_count >= config.CONSENSUS_ROUND_DOUBLE_SPEND_MAX) {
                    consensusData.active = false;
                    this._transactionValidationRejected.add(transactionID);
                    console.log('[consensus][request] the transaction ', transactionID, ' was not validated (due to double spend) during consensus round number ', consensusData.consensus_round_count);
                    return database.applyShardZeroAndShardRepository('transaction', transaction.shard_id, transactionRepository => {
                        return transactionRepository.setTransactionAsDoubleSpend(transaction, data.transaction_id_fail /*double spend input*/);
                    }).then(() => wallet._checkIfWalletUpdate(new Set(_.map(transaction.transaction_output_list, o => o.address_key_identifier))))
                                   .then(() => {
                                       consensusData.resolve();
                                   })
                                   .catch(() => {
                                       consensusData.resolve();
                                   });
                }
            }
            else if (isNotFound) {
                consensusData.consensus_round_double_spend_count++;
                if (consensusData.consensus_round_not_found_count >= config.CONSENSUS_ROUND_NOT_FOUND_MAX) {
                    consensusData.active = false;
                    console.log('[consensus][request] the transaction ', transactionID, ' was not validated (due to not found reply) during consensus round number ', consensusData.consensus_round_count);
                    this._transactionValidationRejected.add(transactionID);
                    return database.applyShardZeroAndShardRepository('transaction', transaction.shard_id, transactionRepository => {
                        return transactionRepository.timeoutTransaction(transactionID);
                    }).then(() => {
                        consensusData.resolve();
                    });
                }
            }
        }
        else {
            console.log('[consensus][request] transaction ', transactionID, ' validated after receiving all replies for this consensus round');
            consensusData.consensus_round_validation_count++;
            if (consensusData.consensus_round_validation_count >= config.CONSENSUS_ROUND_VALIDATION_REQUIRED) {
                consensusData.active = false;

                if (!transaction) {
                    return database.getRepository('transaction')
                                   .setPathAsStableFrom(transactionID)
                                   .then(() => consensusData.resolve());
                }

                return database.applyShardZeroAndShardRepository('transaction', transaction.shard_id, transactionRepository => {
                    return transactionRepository.setPathAsStableFrom(transactionID);
                }).then(() => wallet._checkIfWalletUpdate(new Set(_.map(transaction.transaction_output_list, o => o.address_key_identifier))))
                               .then(() => {
                                   consensusData.resolve();
                               })
                               .catch(() => {
                                   consensusData.resolve();
                               });
            }
        }
        this._nextConsensusRound(transactionID);
    }

    doConsensusTransactionValidationWatchDog() {
        for (let [transactionID, consensusData] of Object.entries(this._consensusRoundState)) {
            if (consensusData.active && (Date.now() - consensusData.timestamp) >= config.CONSENSUS_VALIDATION_WAIT_TIME_MAX) {
                console.log('[consensus][watchdog] killed by watch dog txid: ', transactionID, ' - consensus round: ', consensusData.consensus_round_count);
                const consensusRoundResponseData = consensusData.consensus_round_response[consensusData.consensus_round_count];
                for (let [nodeID, consensusNodeResponseData] of Object.entries(consensusRoundResponseData)) {
                    if (!consensusNodeResponseData.response) {
                        delete consensusRoundResponseData[nodeID];
                    }
                }
                consensusData.requestPeerValidation();
                consensusData.timestamp = Date.now();
            }
        }

        for (let [nodeID, validationData] of Object.entries(this._transactionValidationState)) {
            if ((Date.now() - validationData.timestamp) >= config.CONSENSUS_VALIDATION_WAIT_TIME_MAX) {
                delete this._transactionValidationState[nodeID];
            }
        }

        return Promise.resolve();
    }

    doValidateTransaction() {
        const consensusCount = _.keys(this._consensusRoundState).length;
        if (consensusCount >= config.CONSENSUS_VALIDATION_PARALLEL_PROCESS_MAX) {
            console.log('[consensus][request] maximum number of transactions validation running reached : ', config.CONSENSUS_VALIDATION_PARALLEL_PROCESS_MAX);
            return Promise.resolve();
        }

        let excludeTransactionList = Array.from(this._transactionValidationRejected.keys());
        if (excludeTransactionList.length > 900) { //max sqlite parameters are 999
            excludeTransactionList = _.sample(excludeTransactionList, 900);
        }

        // lock a spot in the consensus state
        const lockerID                      = `locker-${consensusCount}`;
        this._consensusRoundState[lockerID] = true;
        console.log('[consensus][request] get unstable transactions');
        return new Promise(resolve => {
            database.applyShards((shardID) => {
                return database.getRepository('transaction', shardID)
                               .getWalletUnstableTransactions(wallet.defaultKeyIdentifier, excludeTransactionList)
                               .then(pendingTransactions => {
                                   // filter out tx that were synced in the
                                   // last 30s and not being validated yet
                                   return _.filter(pendingTransactions, transaction => !(transaction.create_date - transaction.transaction_date > 30 && Date.now() - transaction.create_date < 30 && !this._consensusRoundState[transaction.transaction_id]));
                               });
            }).then(pendingTransactions => {
                if (pendingTransactions.length === 0) {
                    return database.applyShards((shardID) => {
                        return database.getRepository('transaction', shardID)
                                       .findUnstableTransaction(excludeTransactionList);
                    }).then(transactions => [
                        _.filter(transactions, transaction => !(transaction.create_date - transaction.transaction_date > 30 && Date.now() - transaction.create_date < 30 && !this._consensusRoundState[transaction.transaction_id])),
                        false
                    ]);
                }
                else {
                    return [
                        pendingTransactions,
                        true
                    ];
                }
            }).then(([pendingTransactions, isTransactionFundingWallet]) => {
                console.log('[consensus][request] get unstable transactions done');
                let rejectedTransactions = _.remove(pendingTransactions, t => this._transactionValidationRejected.has(t.transaction_id) || this._consensusRoundState[t.transaction_id]);
                let pendingTransaction   = pendingTransactions[0];

                if (!pendingTransaction) {
                    pendingTransaction = rejectedTransactions[0];
                }

                if (!pendingTransaction) {
                    console.log('[consensus][request] no pending funds available for validation.');
                    delete this._consensusRoundState[lockerID];
                    return resolve();
                }

                const transactionID = pendingTransaction.transaction_id;
                console.log('[consensus][request] starting consensus round for ', transactionID);

                if (isTransactionFundingWallet) {
                    this._transactionRetryValidation[transactionID] = Date.now();
                }

                if (this._consensusRoundState[transactionID]) {
                    // remove locker
                    delete this._consensusRoundState[lockerID];
                    return resolve();
                }

                delete this._consensusRoundState[lockerID];
                this._consensusRoundState[transactionID] = {};

                let unstableDateStart = ntp.now();
                unstableDateStart.setMinutes(unstableDateStart.getMinutes() - config.TRANSACTION_OUTPUT_EXPIRE_OLDER_THAN);
                return this._validateTransaction(transactionID, null, 0)
                           .then(() => {
                               if (![
                                   '0a0',
                                   '0b0',
                                   'la0l',
                                   'lb0l'
                               ].includes(pendingTransaction.version)) {
                                   pendingTransaction.transaction_date = new Date(pendingTransaction.transaction_date * 1000);
                               }
                               else {
                                   pendingTransaction.transaction_date = new Date(pendingTransaction.transaction_date);
                               }

                               if (unstableDateStart.getTime() >= pendingTransaction.transaction_date.getTime()) {
                                   console.log('[consensus] transaction validated internally: the transaction is expired, consensus round dismissed');
                                   return database.applyShardZeroAndShardRepository('transaction', pendingTransaction.shard_id, transactionRepository => {
                                       return transactionRepository.setPathAsStableFrom(transactionID);
                                   }).then(() => wallet._checkIfWalletUpdate(new Set(_.map(pendingTransaction.transaction_output_list, o => o.address_key_identifier))));
                               }
                               else {
                                   console.log('[consensus] transaction validated internally, starting consensus using oracles');
                                   // replace lock id with transaction id
                                   this._consensusRoundState[transactionID] = {
                                       consensus_round_validation_count  : 0,
                                       consensus_round_double_spend_count: 0,
                                       consensus_round_not_found_count   : 0,
                                       consensus_round_count             : 0,
                                       consensus_round_response          : [{}],
                                       timestamp                         : Date.now(),
                                       active                            : true
                                   };
                                   return this._startConsensusRound(transactionID);
                               }
                           })
                           .then(() => {
                               delete this._transactionRetryValidation[transactionID];
                               delete this._consensusRoundState[transactionID];
                               delete this._validationPrepareState[transactionID];
                               resolve();
                               //check if there is another transaction to
                               // validate
                               setTimeout(() => this.doValidateTransaction(), 0);
                           })
                           .catch((err) => {
                               console.log('[consensus] transaction not validated internally: ', err);
                               if (err.cause === 'transaction_double_spend') {
                                   this._setAsDoubleSpend([pendingTransaction], err.transaction_id_fail);
                                   this._transactionValidationRejected.add(transactionID);
                                   delete this._validationPrepareState[transactionID];
                               }
                               else if (err.cause === 'transaction_not_found') {
                                   wallet.requestTransactionFromNetwork(err.transaction_id_fail, {priority: isTransactionFundingWallet ? 1 : 0}, isTransactionFundingWallet);
                                   // check if we should keep trying
                                   const validationState = this._validationPrepareState[transactionID];
                                   if (!!validationState) {
                                       if (validationState.transaction_id_fail === err.transaction_id_fail) {
                                           validationState.transaction_not_found_count++;
                                           if (validationState.transaction_not_found_count >= config.CONSENSUS_ROUND_NOT_FOUND_MAX) {
                                               if (!isTransactionFundingWallet) {
                                                   console.log('[consensus] transaction not validated internally, starting consensus using oracles');
                                                   // replace lock id with
                                                   // transaction id
                                                   delete this._consensusRoundState[lockerID];
                                                   this._consensusRoundState[transactionID] = {
                                                       consensus_round_validation_count  : 0,
                                                       consensus_round_double_spend_count: 0,
                                                       consensus_round_not_found_count   : 0,
                                                       consensus_round_count             : 0,
                                                       consensus_round_response          : [{}],
                                                       timestamp                         : Date.now(),
                                                       active                            : true
                                                   };
                                                   return this._startConsensusRound(transactionID)
                                                              .then(() => {
                                                                  delete this._transactionRetryValidation[transactionID];
                                                                  delete this._consensusRoundState[transactionID];
                                                                  delete this._validationPrepareState[transactionID];
                                                                  resolve();
                                                              }).catch(resolve);
                                               }
                                               else {
                                                   // set timeout
                                                   this._transactionValidationRejected.add(transactionID);
                                                   return database.applyShardZeroAndShardRepository('transaction', pendingTransaction.shard_id, transactionRepository => {
                                                       return transactionRepository.timeoutTransaction(transactionID);
                                                   }).then(() => {
                                                       delete this._transactionRetryValidation[transactionID];
                                                       delete this._consensusRoundState[transactionID];
                                                       delete this._validationPrepareState[transactionID];
                                                       resolve();
                                                   });
                                               }
                                           }
                                       }
                                       else {
                                           validationState.transaction_not_found_count = 1;
                                           validationState.transaction_id_fail         = err.transaction_id_fail;
                                       }
                                   }
                                   else {
                                       this._validationPrepareState[transactionID] = {
                                           transaction_not_found_count: 1,
                                           transaction_id_fail        : err.transaction_id_fail
                                       };
                                   }
                               }
                               setTimeout(() => {
                                   delete this._transactionRetryValidation[transactionID];
                                   delete this._consensusRoundState[transactionID];
                                   resolve();
                               }, 5000);
                           });
            }).catch(() => {
                resolve();
            });
        });
    }

}


export default new WalletTransactionConsensus();
