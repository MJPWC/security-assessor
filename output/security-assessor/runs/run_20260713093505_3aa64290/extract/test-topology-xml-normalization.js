import assert from 'node:assert/strict';
import DiagramGenerationAgent from './src/agent/DiagramGenerationAgent.js';

const prototype = DiagramGenerationAgent.prototype;
const normalizer = {
  _parseStyle: prototype._parseStyle,
  _serializeStyle: prototype._serializeStyle
};

const topologyXml = `<mxGraphModel><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="2" value="Client" vertex="1" parent="1"><mxGeometry x="20" y="100" width="120" height="50" as="geometry"/></mxCell>
<mxCell id="3" value="Gateway" vertex="1" parent="1"><mxGeometry x="250" y="100" width="120" height="50" as="geometry"/></mxCell>
<mxCell id="4" value="Runtime" vertex="1" parent="1"><mxGeometry x="500" y="60" width="120" height="50" as="geometry"/></mxCell>
<mxCell id="5" value="Queue" vertex="1" parent="1"><mxGeometry x="500" y="180" width="120" height="50" as="geometry"/></mxCell>
<mxCell id="10" value="HTTPS" style="strokeWidth=1;" edge="1" source="2" target="3" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>
<mxCell id="11" value="HTTPS" style="" edge="1" source="3" target="4" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>
<mxCell id="12" value="MQ" style="dashed=1;" edge="1" source="3" target="5" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>
</root></mxGraphModel>`;

const result = prototype._normalizeAndValidateTopologyXml.call(normalizer, topologyXml);
assert.equal(result.valid, true, result.issues.join('; '));
assert.equal(result.metrics.vertices, 4);
assert.equal(result.metrics.edges, 3);
assert.match(result.xml, /edgeStyle=orthogonalEdgeStyle/);
assert.match(result.xml, /endArrow=block/);
assert.match(result.xml, /strokeWidth=2\.5/);
assert.match(result.xml, /labelBackgroundColor=#ffffff/);
assert.match(result.xml, /id="11"[^>]*exitY=0\.33/);
assert.match(result.xml, /id="12"[^>]*exitY=0\.67/);
assert.match(result.xml, /id="12"[^>]*dashed=1/);

const unlabeledXml = topologyXml.replace('value="MQ"', 'value=""');
const invalidResult = prototype._normalizeAndValidateTopologyXml.call(normalizer, unlabeledXml);
assert.equal(invalidResult.valid, false);
assert.ok(invalidResult.issues.some(issue => issue.includes('no protocol or transport label')));

console.log('Topology XML normalization tests passed');
