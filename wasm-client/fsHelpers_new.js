
const setupVM = require('./util/setupVM_new')
const fs = require("fs")

let secret = fs.readFileSync(__dirname + "/secret")

exports.makeRandom = function (n) {
    let res = ""
    for (let i = 0; i < n * 2; i++) {
        res += Math.floor(Math.random() * 16).toString(16)
    }
    return res
}

function getLeaf(lst, loc) {
    if (loc % 2 == 1) return lst[1]
    else return lst[0]
}

function parseId(str) {
    var res = ""
    for (var i = 0; i < str.length; i++) res = (str.charCodeAt(i) - 65).toString(16) + res
    return "0x" + res;
}

function parseData(lst, size) {
    var res = []
    lst.forEach(function (v) {
        for (var i = 1; i <= 32; i++) {
            res.push(parseInt(v.substr(i * 2, 2), 16))
        }
    })
    res.length = size
    return Buffer.from(res)
}

function arrange(arr) {
    var res = []
    var acc = ""
    arr.forEach(function (b) { acc += b; if (acc.length == 64) { res.push("0x" + acc); acc = "" } })
    if (acc != "") res.push("0x" + acc)
    return res
}

exports.init = function (fileSystem, web3, mcFileSystem, logger, incentiveLayer, account, config) {

    const merkleComputer = require("./merkle-computer")(logger, './../wasm-client/ocaml-offchain/interpreter/wasm', config.jit_path)

    async function createFile(fname, buf) {
        var nonce = await web3.eth.getTransactionCount(account)
        var arr = []
        for (var i = 0; i < buf.length; i++) {
            if (buf[i] > 15) arr.push(buf[i].toString(16))
            else arr.push("0" + buf[i].toString(16))
        }
        // console.log("Nonce file", nonce, {arr:arr, buf:buf, arranged: arrange(arr)})
        var tx = await fileSystem.methods.createFileWithContents(fname, nonce, arrange(arr), buf.length).send( { from: account, gas: 200000 })
        var id = await fileSystem.methods.calcId(nonce).call( { from: account, gas: 200000 })
        var lst = await fileSystem.methods.getData(id).call( { from: account, gas: 200000 })
        // console.log("Ensure upload", {data:lst})
        return id
    }

    /*function uploadIPFS(fname, buf) {
        return new Promise(function (cont, err) {
            ipfs.files.add([{ content: buf, path: fname }], function (err, res) {
                cont(res[0])
            })
        })
    }*/

    async function createIPFSFile(fname, buf) {
        let res = await mcFileSystem.upload(buf, fname)
        let hash = res[0]
        let info = merkleComputer.merkleRoot(web3, buf)
        let nonce = await web3.eth.getTransactionCount(account)
        console.log("Adding ipfs file", fname, buf.length, hash.hash, info, nonce)
        await fileSystem.methods.addIPFSFile(fname, buf.length, hash.hash, info, nonce).send( { from: account, gas: 200000 })
        logger.info("Calculating ID")
        var id = await fileSystem.methods.calcId(nonce).call( { from: account, gas: 200000 })
        return id
    }

    async function createContractFile(fname, buf) {
        let contractAddress = await merkleComputer.uploadOnchain(buf, web3, { from: account, gas: 30000 })
        let nonce = await web3.eth.getTransactionCount(base)
        let info = merkleComputer.merkleRoot(web3, buf)

        await fileSystem.methods.addContractFile(fname, nonce, contractAddress, info.root, buf.length).send( { from: account, gas: 200000 })

        let fileID = await fileSystem.calcId(nonce).call( { from: account })

        return fileID
    }

    async function uploadFile(fname, buf, type) {
        let fileID

        if (type == 0) {
            //Write to bytes
            fileID = await createFile(fname, buf)
        } else if (type == 1) {
            //Write to contract
            fileID = await createContractFile(fname, buf)
        } else if (type == 2) {
            //Write to IPFS
            fileID = await createIPFSFile(fname, buf)
        } else {
            throw new Error("Invalid file type")
        }

        return fileID
    }

    async function uploadOutputs(taskID, vm) {
        let lst = await incentiveLayer.methods.getUploadNames(taskID).call()
        let types = await incentiveLayer.methods.getUploadTypes(taskID).call()
        console.log("Uploading", { names: lst, types: types })
        if (lst.length == 0) return
        let proofs = await vm.fileProofs() // common.exec(config, ["-m", "-input-proofs", "-input2"])
        // var proofs = JSON.parse(proofs)
        // console.log("Uploading", {names:lst, types:types, proofs: proofs})
        for (let i = 0; i < lst.length; i++) {
            // find proof with correct hash
            console.log("Findind upload proof", { hash: lst[i], kind: types[i] })
            let hash = lst[i]
            let proof = proofs.find(el => getLeaf(el.name, el.loc) == hash)

            if (!proof) {
                logger.error("Cannot find proof for a file")
                continue
            }

            // console.log("Found proof", proof)
            let fname = proof.file.substr(0, proof.file.length - 4)
            let buf = await vm.readFile(proof.file)

            let fileID = await uploadFile(fname, buf, types[i].toNumber())

            await incentiveLayer.methods.uploadFile(taskID, i, fileID, proof.name, proof.data, proof.loc).send( { from: account, gas: 1000000 })
        }
    }

    async function getFile(fileID) {
        let fileType = parseInt(await fileSystem.methods.getFileType(fileID).call())
        let fileName = await fileSystem.methods.getName(fileID).call()

        let fileData

        let size = await fileSystem.methods.getByteSize(fileID).call()
        console.log("Getting file", fileName, "Type:", fileType, "Size:", size)

        if (fileType == 0) {
            // Retrieve from bytes

            let data = await fileSystem.methods.getData(fileID).call()

            fileData = parseData(data, size)
        } else if (fileType == 1) {
            // Retrieve from contract
            let hexData = await fileSystem.methods.getCode(fileID).call()
            fileData = Buffer.from(hexData.substr(2), "hex")
        } else if (fileType == 2) {
            // Retrieve from IPFS
            let ipfsHash = await fileSystem.methods.getHash(fileID).call()
            fileData = (await mcFileSystem.download(ipfsHash, "task.wast")).content
        } else {
            throw new Error("File type unrecognized " + fileType)
        }

        return [fileName, fileData]
    }

    async function setupVMWithFS_aux(taskInfo) {
        let taskID = taskInfo.taskID
        let bundleID = taskInfo.bundleId

        let codeFileID = await fileSystem.methods.getCodeFileID(bundleID).call()
        let fileIDs = await fileSystem.methods.getFiles(bundleID).call()

        let [codeName, codeBuf] = await getFile(codeFileID)

        let files = []

        if (fileIDs.length > 0) {
            for (let i = 0; i < fileIDs.length; i++) {
                let [fileName, fileBuf] = await getFile(fileIDs[i])

                files.push({
                    name: fileName,
                    dataBuf: fileBuf
                })
            }
        }

        return setupVM(
            incentiveLayer,
            merkleComputer,
            taskID,
            codeBuf,
            taskInfo.codeType,
            false,
            files
        )

    }

    async function setupVMWithFS(taskInfo) {
        let vm = await setupVMWithFS_aux(taskInfo)
        let init = await vm.initializeWasmTask()
        if (init.hash != taskInfo.initStateHash) {
            logger.error(`Task was ill-formed: got initial state ${init.hash}, but ${taskInfo.initStateHash} was given by the task giver`)
            throw new Error("Ill formed task")
        }
        return vm
    }

    function makeSecret(data) {
        return web3.utils.soliditySha3(data + secret).substr(2)
    }

    return {
        setupVMWithFS: setupVMWithFS,
        uploadOutputs: uploadOutputs,
        makeSecret
    }

}
