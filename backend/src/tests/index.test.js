import { Crawler } from '../crawler.js';
import { loadConfig } from '../util/config.js';
import { appendProblemDetail } from '../util/storage.js';

const cfg = loadConfig();
const crawler = new Crawler({
  userAgent: cfg.userAgent,
  timeoutMs: cfg.requestTimeoutMs,
  retry: cfg.retry,
  delayMs: cfg.delayMs,
});
const problemDetails = "https://www.bagujing.com/api/problems/${pid}?groupId=${categoryId}";
const problemDetailSample = {
  status: 200,
  body: '{"success":true,"data":{"id":7327,"name":"<p>使用Angular有什么优势？</p>","options":null,"answer":"<p>使用 Angular 有多个优势，以下是一些主要的优点：</p>\\n<ol>\\n  <li>\\n    <p><strong>组件化结构</strong>：Angular 鼓励将应用程序分解为可重用的组件，使得开发和维护更为高效。</p>\\n  </li>\\n  <li>\\n    <p><strong>双向数据绑定</strong>：Angular 的数据绑定机制使得视图和模型之间的同步非常简 单，无需手动更新 DOM。</p>\\n  </li>\\n  <li>\\n    <p><strong>强大的依赖注入</strong>：Angular 的依赖注入系统使得服务的管理和使用更加容易，促进了代码的模块化和可测试性。</p>\\n  </li>\\n  <li>\\n    <p><strong>路由管理</strong>：Angular 提供了内置的路由功能，便于管理单页应用中的视图和导航。</p>\\n  </li>\\n  <li>\\n    <p><strong>前端表单处理</strong>：Angular 提供了强大的表单功能，包括响应式表单和模板驱动表单，简化了用户输入的处理和验证。</p>\\n  </li>\\n  <li>\\n    <p><strong>RxJS 的使用</strong>：Angular 使用 RxJS 库来处理异步数据流，使得处理事件和 HTTP 请求变得更加简单和高效。</p>\\n  </li>\\n  <li>\\n    <p><strong>良好的社区支持</strong>：Angular 拥有庞大的社区和丰富的资源，包括教程、文档和开源库，方便开发者学习和解决问题。</p>\\n  </li>\\n  <li>\\n    <p><strong>强类型支持</strong>：使用 TypeScript 开发，带来良好的代码提示和类型检查，帮助开发者更早发现错误。</p>\\n  </li>\\n  <li>\\n    <p><strong>跨平台支持</strong>：Angular 支持 Web、移动端和桌面端的开发，使得应用能够在多种 平台上运行。</p>\\n  </li>\\n  <li>\\n    <p><strong>企业级解决方案</strong>：Angular 设计时就考虑到企业应用的需求，包含很多企业级的功能，如权限管理、国际化等。</p>\\n  </li>\\n</ol>\\n<p>总的来说，Angular 提供了一个功能强大且灵活的框架，适用于大规模和复杂的前端应用开发。</p>","type":6,"level":1,"freq":0,"analysis":"<h3>1. 题目核心</h3>\\n<ul>\\n  <li><strong>问题</strong>：使用Angular有什么优势？</li>\\n  <li><strong>考察点</strong>：对Angular框架特性、功能及在开发中的价值的了解。</li>\\n</ul>\\n<h3>2. 背景知识</h3>\\n<ul>\\n  <li>Angular是一个开源的JavaScript框架，用于构建Web应用程序，由Google维护和支持。它遵循组件化、模块化的设计思想，提供了丰富的工具和功能来简化开发流程。</li>\\n</ul>\\n<h3>3. 解析</h3>\\n<h4>（1）模块化开发</h4>\\n<ul>\\n  <li>Angular采用模块化架构，开发者可以将应用拆分成多个模块，每个模块专注于特定的功能。这使得代码结构清晰，易于维护和扩展。例如，一个大型的电子商务应用可以拆分成用户模块、商品模块、订单模块等，每个模块独立开发和测试。</li>\\n</ul>\\n<h4>（2）双向 数据绑定</h4>\\n<ul>\\n  <li>双向数据绑定是Angular的一个重要特性，它可以自动同步视图和模型之间的数据。当模型数据发生变化时，视图会自动更新；反之，当用户在视图中修改数据时，模型也会相应更新。这大大减少了手动操作DOM的代码，提高了开发效率。</li>\\n</ul>\\n<h4>（3）依赖注入</h4>\\n<ul>\\n  <li>Angular的依赖注入机制允许开发者将依赖项注入到组件或服务中，而不是在组件内部创建依赖项。这使得代码更易于测试和维护，提高了代码的可复用性。例如，一个组件需要使用一个数据服务来获取数据，通过依赖注入，我们可以将数据服务注入到组件中，而不是在组件内部创建数据服务的实例。</li>\\n</ul>\\n<h4>（4）丰富的指令系统</h4>\\n<ul>\\n  <li>Angular提供了多种内置指令，如<code>ngFor</code>、<code>ngIf</code>等，用于简化DOM操作和实现常见的交互逻辑。开发者还可以自定义指令来满足特定的需求。这些指令使得模板代码更加简洁和易于理 解。</li>\\n</ul>\\n<h4>（5）路由管理</h4>\\n<ul>\\n  <li>Angular的路由系统强大且灵活，支持路由导航、路由参数传递、路由守卫等功能。它可以帮助开发者构建单页面应用（SPA），实现页面之间的无缝切换。</li>\\n</ul>\\n<h4>（6）测试支持</h4>\\n<ul>\\n  <li>Angular提供了完善的测试工具和框架，如Karma和Jasmine，方便开发者进行单元测试和集成测试。这有助于提高代码的质量和稳定性。</li>\\n</ul>\\n<h4>（7）跨平台开发</h4>\\n<ul>\\n  <li>Angular可以用于开发Web应用、移动应用（通过Ionic等框架）和桌面应用（通过Electron等框架），实现一次开发，多平台部署。</li>\\n</ul>\\n<h4>（8）社区和生态系统</h4>\\n<ul>\\n  <li>由于Angular由Google维护，拥有庞大的开发者社区和丰富的生态系统。开发者可以轻松找到各种开源库、插件和教程，加快开发速度。</li>\\n</ul>\\n<h3>4. 示例说明</h3>\\n<pre><code class=\\"language-typescript\\">import { Component } from \'@angular/core\';\\n\\n@Component({\\n  selector: \'app-root\',\\n  template: `\\n    &#x3C;h1>{{ title }}&#x3C;/h1>\\n    &#x3C;button (click)=\\"changeTitle()\\">Change Title&#x3C;/button>\\n  `\\n})\\nexport class AppComponent {\\n  title = \'Angular App\';\\n\\n  changeTitle() {\\n    this.title = \'New Title\';\\n  }\\n}\\n</code></pre>\\n<ul>\\n  <li>在这个示例中， 使用了双向数据绑定（<code>{{ title }}</code>）和事件绑定（<code>(click)</code>），展示了Angular简洁的模板语法和强大的交互功能。</li>\\n</ul>\\n<h3>5. 常见误区</h3>\\n<h4>（1）认为Angular学习成本高就没有优势</h4>\\n<ul>\\n  <li>误区：只看到Angular的学习曲线较陡，而忽略了它带来的长期效益。</li>\\n  <li>纠正：虽然Angular的学习成本相对较高，但一旦掌握，它的模块化、可维护性等优势可以大大提高开发效率和 代码质量。</li>\\n</ul>\\n<h4>（2）过度依赖框架特性</h4>\\n<ul>\\n  <li>误区：在项目中过度使用Angular的各种特性，导致代码复杂度过高。</li>\\n  <li>纠正：应根据项目的实际需求合理使用Angular的特性，避免过度设计。</li>\\n</ul>\\n<h3>6. 总结回答</h3>\\n<p>使用Angular有诸多优势。它采用模块化开发，使代码结构清晰，便于维护和扩展；具备双向数据绑定功能，能自动同步视图和模型数据，减少手动操作DOM的代码；依赖注入机制提高了代码的可测试性和可复用性；丰富的指令系统简化了DOM操作和交互逻辑；强大的路由管理可实现单页面应用的无缝切换；完善的测试支持有助于保证代码质量；支持跨平台开发，能一次开发多平台部署；庞大的 社区和丰富的生态系统为开发提供了便利。不过，要注意合理使用其特性，避免过度依赖和设计。</p>","more_ask":"<p>面试官可能会进一步问：</p>\\n<ol>\\n  <li>\\n    <p><strong>你能举例说明Angular中的数据绑定是如何工作的，以及与其他框架（如React或Vue）的不同之处吗？</strong><br>提示：可以考虑单向和双向数据绑定的区别和应用场景。</p>\\n  </li>\\n  <li>\\n    <p><strong>Angular的模块系统如何帮助组织代码和提升 可维护性？</strong><br>提示：关注模块的概念、惰性加载以及功能模块的划分。</p>\\n  </li>\\n  <li>\\n    <p><strong>可以介绍一下Angular中的依赖注入(DI)是如何实现的吗？</strong><br>提示：讨论DI对组件解耦的影响以及使用的优势。</p>\\n  </li>\\n  <li>\\n    <p><strong>Angular中的生命周期钩子有哪些？请举例说明它们的用途。</strong><br>提示：考虑ngOnInit、ngOnChanges等钩子的具体应用场景。</p>\\n  </li>\\n  <li>\\n    <p><strong>在Angular中如何处理路由？可以简要说明路由守卫的用途吗？</strong><br>提示：讨论路由管理、导航以及安全性控制。</p>\\n  </li>\\n  <li>\\n    <p><strong>你如何在Angular中实现状态管 理？选择Ngrx、BehaviorSubject还是其他方案，你的理由是什么？</strong><br>提示：考虑到复杂性、性能和应用场景。</p>\\n  </li>\\n  <li>\\n    <p><strong>请解释一下Angular中的表单处理，包括反应式表单和模板驱动表单的差异。</strong><br>提示：关注数据流、验证机制和使用场景。</p>\\n  </li>\\n  <li>\\n    <p><strong>如何优化Angular应用的性能？你有哪些实践经验？</strong><br>提示：可以提到懒加载、变更检测策略等方法。</p>\\n  </li>\\n  <li>\\n    <p><strong>Angular中的服务和组件之间的通信方式有哪些？请给出例子。</strong><br>提示：可以讨论事件发射、服务共享等。</p>\\n  </li>\\n  <li>\\n    <p><strong>在Angular中处理错误和异步操作时有哪些最佳实践？</strong><br>提示：考虑使用HTTP拦截器、Promise、Observable等机制。</p>\\n  </li>\\n</ol>","mindmap":"mindmap\\n  Angular的主要优点\\n    组件化结构\\n      可 重用的组件\\n      高效的开发和维护\\n    双向数据绑定\\n      视图与模型同步\\n      简化的DOM更新\\n    强大的依赖注入\\n      服务的管理和使用\\n      代码模块化和可测试性\\n    路由管理\\n      单页应用的视图管理\\n      导航功能\\n    前端表单处理\\n      响应式表单\\n      模板驱动表单\\n    RxJS的使用\\n      异步数据流处理\\n      事件和HTTP请求\\n    良好的社区支持\\n      教程\\n      文档\\n      开源库\\n    强类型支持\\n      TypeScript\\n      代码提示\\n      类型检查\\n    跨平台支持\\n      Web\\n      移动端\\n      桌面端\\n    企业级解决方案\\n      权限管理\\n      国际化","keynote":"- 组件化结构促进代码重用和维护\\n- 双向数据绑定简化视图与模型同步\\n- 强大的依赖注入提升代码模块化和可测试性\\n- 内置路由管理支持单页应用导航\\n- 提供响应式和模板驱动两种表单处理方式\\n-  使用RxJS简化异步操作\\n- 拥有庞大的社区和丰富资源\\n- TypeScript提供强类型支持，增强代码质量\\n- 支持多平台开发\\n- 包含企业级功能，如权限管理和国际化","group_id":61,"kps":["路由","模板","组件","服务","依赖注入"],"years":null,"corps":null}}',
  title: ''
}

function formatData(body) {
  const realData = body??{};
  const {success, data} = JSON.parse(realData);
  return success ? data : null;
}

function testProblemDetail() {
  const detailUrl = problemDetails
      .replace('${categoryId}',61)
      .replace('${pid}', 7327);
  crawler.fetch(detailUrl, {
    headers: {
      Cookie: 'bgj_sid=%7B%22name%22%3A%22%E5%8F%AF%E4%B9%90%22%2C%22wxId%22%3A%22ooGq45qIKYTv0f8d2by8pGueHgiM%22%2C%22isMember%22%3Atrue%2C%22isTrial%22%3Afalse%2C%22id%22%3A8053%2C%22imageUrl%22%3A%22https%3A%2F%2Fthirdwx.qlogo.cn%2Fmmopen%2Fvi_32%2FDYAIOgq83ertjV6MLPDrd7VE8vDee2Q2gIyV6aK6p7BcypCiaVxADibSP6XTnFQDxxdjibzMO51NtN4vOeHSp6iamQ%2F132%22%2C%22ts%22%3A1765779972028%2C%22src%22%3A%22c%22%7D.idCgAHWXVUr3ibeI0IqDjfET3%2FA9OKhQIMU94e8DQJs; Hm_lvt_fe45b9a4fbfe96cbbe00125a4301cad9=1765172450,1765422083,1765507373,1765779973; Hm_lpvt_fe45b9a4fbfe96cbbe00125a4301cad9=1765779973; HMACCOUNT=E7269398A09B64D5; _clck=k9bv3%5E2%5Eg1v%5E0%5E2165; _clsk=7pojkq%5E1765781077584%5E2%5E1%5Es.clarity.ms%2Fcollect'
    }
  }).then((result) => {
    if (result?.status === 200 && result?.body) {
      const formattedData = formatData(result.body);
      if (formattedData) {
        appendProblemDetail(detailUrl, formattedData);
      }
    } else {
      console.log('invalid problem detail response', result);
    }
  }).catch((err) => {
    console.log(`failed to fetch problem detail data`, err.message);
  });
}

testProblemDetail();  