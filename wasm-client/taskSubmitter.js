const depositsHelper = require('./depositsHelper')
const fs = require('fs')
const contract = require('./contractHelper')
const assert = require('assert')
const path = require('path')

const contractsConfig = require('./util/contractsConfig')

function isString(n) {
    return typeof n == 'string' || n instanceof String
}

function setup(web3) {
    return (async () => {
        const httpProvider = web3.currentProvider
        const config = await contractsConfig(web3)
        let incentiveLayer = await contract(httpProvider, config['incentiveLayer'])
        let fileSystem = await contract(httpProvider, config['fileSystem'])
        let tru = await contract(httpProvider, config['tru'])
        return [incentiveLayer, fileSystem, tru]
    })()
}

function verifyTaskFormat(task) {
    assert(task.from != undefined)
    assert(task.minDeposit != undefined)
    assert(task.codeType != undefined)
    assert(task.storageType != undefined)
    assert(task.reward != undefined)
}

function verifyBundlePayloadFormat(bundlePayload) {
    assert(bundlePayload.from != undefined)
    assert(bundlePayload.gas != undefined)
    assert(bundlePayload.contractAddress != undefined)
    assert(bundlePayload.initHash != undefined)
}

const readFile = (filepath) => {
    return new Promise((resolve, reject) => {
        fs.readFile(filepath, (err, res) => {
            if (err) reject(err)
            else resolve(res)
        })
    })
}

const writeFile = (filepath, buf) => {
    return new Promise((resolve, reject) => {
        fs.writeFile(filepath, buf, (err) => {
            if (err) reject(err)
            else { resolve(filepath) }
        })
    })
}

let submittedTasks = []

module.exports = async (web3, logger, mcFileSystem) => {

    let contracts = await setup(web3)
    const merkleComputer = require('./merkle-computer')(logger, './../wasm-client/ocaml-offchain/interpreter/wasm')

    const typeTable = {
        "WAST": merkleComputer.CodeType.WAST,
        "WASM": merkleComputer.CodeType.WASM
    }

    //Two filesystems (which may be confusing)
    //tbFileSystem is the Truebit filesystem contract
    //mcFileSystem is a module for ipfs helpers from merkleComputer module

    incentiveLayer = contracts[0]
    tbFileSystem = contracts[1]
    tru = contracts[2]

    async function uploadOnchain(codeData, options) {
        return merkleComputer.uploadOnchain(codeData, web3, options)
    }

    async function getInitHash(config, path) {

        vm = merkleComputer.init(config, path)

        let interpreterArgs = []

        let initHash = (await vm.initializeWasmTask(interpreterArgs)).hash

        return initHash
    }

    async function getCodeRoot(config, path) {

        vm = merkleComputer.init(config, path)

        let interpreterArgs = []

        let codeRoot = (await vm.initializeWasmTask(interpreterArgs)).vm.code

        return codeRoot
    }

    async function makeBundle(account) {
        let bundleNonce = Math.floor(Math.random() * Math.pow(2, 60))
        let bundleId = await tbFileSystem.calcId.call(bundleNonce, { from: account })

        await tbFileSystem.makeBundle(bundleNonce, { from: account, gas: 300000, gasPrice: web3.gp })

        return bundleId
    }

    async function uploadIPFS(codeBuf, config, from, dirPath) {
        assert(Buffer.isBuffer(codeBuf))

        let bundleID = await makeBundle(from)

        let ipfsFile = (await mcFileSystem.upload(codeBuf, "task.wast"))[0]

        let ipfsHash = ipfsFile.hash
        let name = ipfsFile.path

        let randomNum = Math.floor(Math.random() * Math.pow(2, 60))
        let size = codeBuf.byteLength
        let codeRoot = await getCodeRoot(config, dirPath)

        let fileRoot = merkleComputer.merkleRoot(web3, codeBuf)

        let codeFileID = await tbFileSystem.calcId.call(randomNum, { from: from })

        await tbFileSystem.addIPFSFile(name, size, ipfsHash, fileRoot, randomNum, { from: from, gas: 300000, gasPrice: web3.gp })

        await tbFileSystem.setCodeRoot(codeFileID, codeRoot, { from: from, gas: 100000, gasPrice: web3.gp })

        await tbFileSystem.finalizeBundle(bundleID, codeFileID, { from: from, gas: 100000, gasPrice: web3.gp })

        let initHash = await tbFileSystem.getInitHash.call(bundleID)

        return [bundleID, initHash]
    }

    async function uploadIPFSFiles(codeBuf, config, from, dirPath) {
        assert(Buffer.isBuffer(codeBuf))

        let bundleID = await makeBundle(from)

        let ipfsFile = (await mcFileSystem.upload(codeBuf, "task.wast"))[0]

        let ipfsHash = ipfsFile.hash
        let codeName = ipfsFile.path
        let codeSize = ipfsFile.size

        let newFiles = []

        for (let i = 0; i < config.files.length; i++) {
            let filePath = config.files[i]
            let fileBuf = await readFile(process.cwd() + filePath)

            let fileName = path.basename(filePath)
            let newFilePath = dirPath + "/" + fileName
            newFiles.push(newFilePath)

            await writeFile(newFilePath, fileBuf)

            let fileSize = fileBuf.byteLength
            let fileRoot = merkleComputer.merkleRoot(web3, fileBuf)

            let fileNonce = Math.floor(Math.random() * Math.pow(2, 60))

            let fileIPFSHash = (await mcFileSystem.upload(fileBuf, "bundle/" + fileName))[0].hash

            let fileID = await tbFileSystem.calcId.call(fileNonce, { from: from })

            await tbFileSystem.addIPFSFile(
                fileName,
                fileSize,
                fileIPFSHash,
                fileRoot,
                fileNonce,
                { from: from, gas: 200000, gasPrice: web3.gp }
            )

            await tbFileSystem.addToBundle(bundleID, fileID, { from: from, gasPrice: web3.gp })
        }

        let randomNum = Math.floor(Math.random() * Math.pow(2, 60))
        let codeFileId = await tbFileSystem.calcId(randomNum, { from: from, gasPrice: web3.gp })

        config.files = newFiles

        let codeRoot = await getCodeRoot(config, dirPath)
        let fileRoot = merkleComputer.merkleRoot(web3, codeBuf)

        await tbFileSystem.addIPFSCodeFile(codeName, codeSize, ipfsHash, fileRoot, codeRoot, randomNum, { from: from, gas: 300000, gasPrice: web3.gp })

        await tbFileSystem.finalizeBundle(bundleID, codeFileId, { from: from, gas: 1500000, gasPrice: web3.gp })

        let initHash = await tbFileSystem.getInitHash.call(bundleID)

        return [bundleID, initHash]
    }

    //This also creates a directory for the random path if it doesnt exist

    function setupTaskConfiguration(task) {
        task["codeType"] = typeTable[task.codeType]

        if (!task.files) {
            task["files"] = []
        }

        if (!task.inputFile) {
            task["inputFile"] = ""
        } else {
            task["inputFile"] = process.cwd() + task.inputFile
        }

        let codeBuf = fs.readFileSync(process.cwd() + task.codeFile)

        let randomPath = process.cwd() + "/tmp.giver_" + Math.floor(Math.random() * Math.pow(2, 60)).toString(32)

        if (!fs.existsSync(randomPath)) fs.mkdirSync(randomPath)
        fs.writeFileSync(randomPath + "/" + path.basename(task.codeFile), codeBuf)


        let config = {
            code_file: path.basename(task.codeFile),
            input_file: task.inputFile,
            actor: {},
            files: task.files,
            code_type: task.codeType
        }

        return [config, randomPath, codeBuf]

    }

    async function submitTask_aux(task) {

        let [config, randomPath, codeBuf] = setupTaskConfiguration(task)

        if (task.storageType == "IPFS") {

            if (task.files == []) {
                let [bundleID, initHash] = await uploadIPFS(codeBuf, config, task.from, randomPath)

                task["bundleID"] = bundleID
                task["initHash"] = initHash
            } else {
                let [bundleID, initHash] = await uploadIPFSFiles(codeBuf, config, task.from, randomPath)
                task["bundleID"] = bundleID
                task["initHash"] = initHash
            }

            logger.log({
                level: 'info',
                message: `Uploaded data to IPFS`
            })

        } else { //store file on blockchain
            let contractAddress = await uploadOnchain(codeBuf, { from: task.from, gas: 4000000, gasPrice: web3.gp })

            logger.log({
                level: 'info',
                message: `Uploaded data onchain`
            })

            let codeRoot = await getCodeRoot(config, randomPath)
            let fileRoot = merkleComputer.merkleRoot(web3, codeBuf)
            let codeFileNonce = Math.floor(Math.random() * Math.pow(2, 60))
            let codeFileId = await tbFileSystem.calcId.call(codeFileNonce, { from: task.from })
            // let codeFileId2 = await tbFileSystem.calcId.call(codeFileNonce)
            // console.log("code file nonce", codeFileNonce, codeFileId, codeFileId2, task.from)

            let size = Buffer.byteLength(codeBuf, 'utf8');

            await tbFileSystem.addContractFile("task.wasm", codeFileNonce, contractAddress, fileRoot, size, { from: task.from, gas: 300000, gasPrice: web3.gp })
            await tbFileSystem.setCodeRoot(codeFileId, codeRoot, { from: task.from, gas: 100000 , gasPrice: web3.gp})

            let bundleID = await makeBundle(task.from)

            await tbFileSystem.finalizeBundle(bundleID, codeFileId, { from: task.from, gas: 3000000, gasPrice: web3.gp })
            let initHash = await tbFileSystem.finalizeBundle.call(bundleID, codeFileId, { from: task.from, gas: 3000000, gasPrice: web3.gp })

            logger.log({
                level: 'info',
                message: `Registered deployed contract with truebit filesystem`
            })

            task["bundleID"] = bundleID
            task["initHash"] = initHash
        }

        //bond minimum deposit
        // task.minDeposit = web3.utils.toWei(task.minDeposit, 'ether')
        task.reward = web3.utils.toWei(task.reward, 'ether')
        let taxrate = await incentiveLayer.getTaxRate.call()
        let cost = task.reward * (parseInt(taxrate)+1)
        console.log("deposit", cost)
        await depositsHelper(web3, incentiveLayer, tru, task.from, cost)

        logger.log({ level: 'info', message: `Minimum deposit was met` })

        if (isString(task.maxDifficulty)) task.maxDifficulty = parseInt(task.maxDifficulty)
        if (isString(task.reward)) task.reward = parseInt(task.reward)

	//gmytil: the `id` name is quite misleading here. While the createTask solidity method returns a task id
	//the contract call through web3 javascript returns the contract instance with all its methods and events; not only the id.
	//To inspect the JSON information, I can do something like:
	// web3.utils.hexToAscii(web3.utils.toHex(JSON.stringify(id)))
	
        let id = await incentiveLayer.createTask(
            task.initHash,
            task.codeType,
            task.bundleID,
            task.maxDifficulty,
            task.reward,
            { gas: 1000000, from: task.from, gasPrice: web3.gp }
        )

	submittedTasks.push({
		account: task.from,
		taskID: id.logs[0].args.task
	})

        logger.log({
            level: 'info',
            message: 'Task ' + id.logs[0].args.task + ' was created.'
        })

        return id

    }

    return {

        getInitialHash: async (task) => {

            let [config, randomPath, codeBuf] = setupTaskConfiguration(task)

            let initHash = await getInitHash(config, randomPath)

            return initHash

        },

        submitTask: async (task) => {
            try {
                return await submitTask_aux(task)
            }
            catch (e) {
                logger.error(`TASK SUBMITTER: Cannot create task: ${e}`)
            }
        },

	getTasks: async (account) => {
	    let tasks = submittedTasks.filter(a => a.account == account);
	    return tasks;
	}
    }
}
