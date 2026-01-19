const express = require('express'); //引入express框架
const cors = require('cors'); //引入cors 跨域 防止出现跨域问题
const bodyParser = require('body-parser'); //引入body-parser 解析请求体
const fs = require('fs'); // 引入node fs处理文件模块
const path = require('path'); // 引入node path路径处理模块
const app = express(); //创建express应用实例
app.use(cors()); // 允许所有跨域请求
app.use(bodyParser.json()); //解析json格式请求体

const rootPath = path.resolve(__dirname, '..'); // 声明根路径是当前文件的上一级
const PORT = 3000; // 声明端口号是3000
app.all('api/analyze', (req, res) => {
   const filePath = req.query.path || req.body.path; //获取文件路径
   const column = req.query.column; //获取文件列数
   const line = req.query.line; //获取文件行数

   const fullPath = path.join(rootPath, filePath); //获取文件的绝对路径
   try {
      // 找不到该文件
      if(!fs.existsSync(fullPath)) {
          res.status(404).json({
            error: '文件错误，无法找到该文件：' + fullPath
          })
      }
      const fileContent = fs.readFileSync(fullPath, 'utf-8'); // 读取文件内容
      res.json({
        message:'读取成功',
        path: filePath,
        content: fileContent,
        column,
        line,
      })
   }
   catch (err) {
      console.error('读取文件失败：' + err);
      res.status(500).json({
        error: '服务器内部错误'
      })
   }
})
app.listen(PORT, () => {
  console.log(`🚀 AI Trace 后端服务已启动: http://localhost:${PORT}`);
  console.log(`📁 项目根目录: ${rootPath}`);
})
