const { parser } = require('@babel/parser');
const { traverse } = require('@babel/traverse').default;
const { generate } = require('@babel/generator').default;
// 查找AST中指定行号与列号的节点
function findNodeInAST(node, line, column, parent = null) {
    if(!node || !node.loc) return null; //如果节点不存在 或者没有位置信息 则返回null
    const {start, end} = node.loc; //获取该节点的开始跟其实位置
    node.parent = parent; // 记录父节点
    let isInRange;
    // 该行需要在 开始行与结束行之间
    // 列需要在 开始列与结束列之间
    if( line >= start.line &&
        line <= end.line &&
        (line === start.line ? column >= start.column : true) &&
        (line === end.line ? column <= end.column : true)
    ) {
        isInRange = true;
    }
    // 如果不在范围 则返回null
    if(!isInRange) return null;

    // 如果有子节点，深度优先搜素 优先寻找更匹配的子节点
    if(node.children && node.children.length > 0) {
      for(let child of node.children) {
        //递归查找子节点
        const found = findNodeInAST(child, line, column, node);
        // 如果子节点存在优先匹配node 则返回子节点
        if(found) return found;
      }
    }
    // type = 1 代表是一个标签节点，不是文本节点
    return node.type === 1 ? node : null;
}

// 拿到找寻节点的变量
function getTemplateVariables(node) {
   let vars = new Set(); // 防止收集重复变量
   for(let prop of node.props) {
    // 找到当前绑定指令的表达式
     if(prop.type === 7 && prop.exp && prop.exp.content) {
      // 正则匹配变量名
      const match = prop.exp.content.match(/[a-zA-Z_$][\w$]*/);
      if (match) vars.add(match[0]);
     }
   }
   let finalVars = new Set();

   vars.forEach(v => {

   // 这时已经找到了这个变量，但它不一定是真正存在的变量，可能是遍历出来的隐性变量 所以需要往父节点去找
   let curr = node;
   // 往上遍历 还是利用到递归
   while(curr) {
     //假设已经找到这个v-for变量了
     let vForProp = curr.props?.find(p => p.name === 'for');
     // forParseResult 是vue 解析v-for 指令后的结果 value代表item source代表items
     if(vForProp && vForProp.forParseResult) {
       const {value, source} = vForProp.forParseResult;
       if(value && value.content === v) {
        finalVars.add(source.content);
       }
     }
     curr = curr.parent;
   }
    });
    return Array.from(finalVars);
}
// 提纯脚本
function pureScript(script, varable) {
    //将script转换成ast
    const scriptAST = parser.parse(script, {
        sourceType: 'module',
        plugins: ['jsx','typescript'],
    })
    const keptScriptModule = new Set(); //需要保存的代码块
    const findVars = new Set(varable); //需要找寻的变量
    const queue = [...findVars];//需要找寻的变量队列

    // 开始遍历
    while(queue.length > 0) {
        const currVar = queue.shift();
        // 遍历AST 找到所有的接口、类型别名、调用表达式
        traverse(scriptAST, {
          // 寻找声明的变量跟表达式
          "TSInterfaceDeclaration|TSTypeAliasDeclaration|CallExpression"(path) {
            const currentVar = generate(path.node).code; // 当前节点的代码
            // 如果当前节点的代码包含了当前变量
            if(currentVar.includes(currVar)) {
              // 找到最顶层的节点代码
              let topParent = path.findParent(p => p.parentPath && p.parentPath.isProgram());
              if(!keptScriptModule.has(topParent.node)) {
                captureNode(topParent,keptScriptModule,findVars, queue);
              }
            }
          },
          // 遍历AST 找到所有的变量声明、函数声明、导入指定符
          "VariableDeclarator|FunctionDeclaration|ImportSpecifier"(path) {
            let name = path.isVariableDeclarator() ? path.node.id.name : path.isImportSpecifier() ? path.node.local.name : path.node.id.name;
            if(name === currVar) {
              const topParent = path.findParent(p => p.parentPath && p.parentPath.isProgram());
              if(!keptScriptModule.has(topParent.node)) {
                captureNode(topParent,keptScriptModule,findVars, queue);
              }
            }
          }
        })
    }
    scriptAST.program.body = scriptAST.program.body.filter(node => keptScriptModule.has(node));
    return generate(scriptAST).code;
}
function captureNode(path,keptScriptModule,findVars, queue) {
  keptScriptModule.add(path.node);
  path.traverse({
    Identifier(childPath) {
      // 如果子节点是被引用的话 就是在使用的变量
      if(childPath.isReferencedIdentifier()) {
        const name = childPath.node.name;
        if(!findVars.has(name) && !isBuiltIn(name)) {
          findVars.add(name);
          queue.push(name); //下次循环去抓他
        }
      }
    }
  })
}
function isBuiltIn(name) {
  const builtIns = [
    'ref', 'reactive', 'computed', 'watch', 'onMounted', 'onUnmounted',
    'defineProps', 'withDefaults', 'defineEmits', 'defineOptions',
    'console', 'Math', 'window', 'Object', 'Array'
  ];
  return builtIns.includes(name);
}

//调用ai 分析代码
const { chatOpenAI } = require('@langchain/openai');
const { PromptTemplate } = require("@langchain/core/prompts");
const { StructuredOutputParser} = require('@langchain/core/output_parsers');
const { z } = require("zod");
const { a } = require('vitest/dist/chunks/suite.d.FvehnV49.js');
async function callAI(componentName,targetElement,code) {
  // 1. 初始化模型
  const chatModel = new chatOpenAI({
    apiKey: process.env.AI_API_KEY,
    modelName: process.env.AI_MODEL_NAME,
    configuration: {
      baseURL: process.env.AI_API_BASE_URL,
    },
    temperature: 0,
  })
  //2.定义输出格式
  const parser = StructuredOutputParser.fromZodSchema(
    z.object({
      componentRole: z.string().describe('组件具体承担的角色或功能'),
      logicAnalysis: z.object({
        dataFlow: z.string().describe('组件数据的流程过程'),
        stateManagement: z.string().describe('数据的状态管理机制（如响应式变量、计算属性等）')
      }),
      keyVariables: z.array(z.string()).describe('组件中核心响应式变量及其含义'),
      dataSource: z.string().describe('数据来源：API/Props/Store'),
      apiDependencies: z.array(z.string()).describe('组件依赖的 API 接口（如果有）'),
    })
  )

  const formatStructure = parser.getFormatInstructions();

  // 3.组装七层prompt模版
  const template = `
  # 第一层：角色定义层
  你是一个资深 Vue 响应式变量数据链路分析专家，擅长从提纯的代码片段中精准还原业务逻辑。

  # 第二层：任务描述层
  分析目标组件：{componentName}
  目标 DOM 片段：{targetElement}

  # 第三层：分析要求层
  请重点分析一下维度：
  1、内容变量：插值表达式中的数据来源。
  2、属性变量： 绑定的动态属性，如 :end-val="endVal" 中的 endVal的计算逻辑。
  3、条件变量：控制该元素显示隐藏的逻辑。

  # 第四层：输出格式层
  必须严格按照以下 JSON 格式返回结果：
  {format_instructions}

  # 第五层：源代码层
  以下是经常代码提存后的关键源码片段：
  ---
  {code}
  ---

  # 第六层：接口信息层
  (暂无运行时接口数据，请基于源码中的命名和 Import 语句进行静态推断)

  # 第七层：最终提醒层
  1、必须返回纯 JSON 格式，不要包含任何 Markdown 代码块标签。
  2、确保字段逻辑严密，尤其是数据溯源部分。
  3、即使信息不足，也请基于代码规范给出最合理的推测。
  `

  const prompt = new PromptTemplate({
    template,
    inputVariables: ["componentName", "targetElement", "code"],
    partialVariables: { format_instructions: formatStructure },
  })

  // 4.执行链式调用
  const chain = prompt.pipe(chatModel).pipe(parser);

  try {
    const result = await chain.invoke({
      componentName,
      targetElement,
      code,
    })
    return result;
  } catch (error) {
    console.error("调用AI模型失败:", error);
    throw error;
  }

}
