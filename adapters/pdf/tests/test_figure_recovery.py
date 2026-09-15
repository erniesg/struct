"""Source-shape regressions for crop boundaries and sideways captions."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pdf2struct import StructAdapter
from figure_recovery import adopt_sideways_captions, sideways_box


def block(id, kind, text, x, y, width, height, page=1):
    return dict(id=id,kind=kind,text=text,page=page,inline=[],evidence=dict(boxes=[dict(page=page,x=x,y=y,width=width,height=height,rotation=0)],sourceIds=[id],signals=[]))

class FigureRecovery(unittest.TestCase):
    def adapter(self, blocks):
        a=StructAdapter.__new__(StructAdapter)
        a.blocks=blocks;a._attached_caption_boxes={};a.source_text=None
        a.report=SimpleNamespace(orphan_captions=3,paragraphs=2,figures_with_caption=0,captions_adopted_by_geometry=0)
        a._recrop_figure=Mock()
        return a

    def test_intervening_prose_checks_later_provenance_box(self):
        email=block('email','paragraph','Names and email addresses: a@example.org b@example.org c@example.org',.31,.22,.005,.007)
        email['evidence']['boxes'].append(dict(page=1,x=.11,y=.24,width=.77,height=.011))
        a=self.adapter([email])
        affiliation=dict(x=.32,y=.225,width=.36,height=.01)
        self.assertFalse(a._gap_is_figure_like(1,.276,.515,affiliation,.32,.88))

    def test_rotated_caption_joins_columns_and_includes_legend(self):
        figure=block('fig','figure','',.15,.21,.50,.55)
        caption=block('cap','caption','Figure 2: Boxplots for',.75,.06,.03,.85)
        continuation=block('cont','caption','three models, with',.793,.06,.03,.85)
        end=block('end','caption','the stated sample sizes.',.836,.23,.03,.68)
        unrelated=block('other','caption','Unrelated following page',.836,.23,.03,.68,2)
        a=self.adapter([figure,caption,continuation,end,unrelated]);adopt_sideways_captions(a)
        self.assertEqual(figure['text'],'Figure 2: Boxplots for three models, with the stated sample sizes.')
        self.assertEqual(figure['label'],'Figure 2');self.assertEqual(a.blocks,[figure,unrelated])
        self.assertEqual(figure['evidence']['sourceIds'],['fig','cap','cont','end'])
        self.assertAlmostEqual(a._recrop_figure.call_args.args[3],.735)

    def test_rotated_legend_mislabelled_as_caption_is_replaced(self):
        figure=block('fig','figure','Method A B C',.15,.16,.59,.64)
        caption=block('cap','caption','Figure 1: Estimation errors.',.79,.16,.03,.64)
        a=self.adapter([figure,caption]);adopt_sideways_captions(a)
        self.assertEqual(figure['label'],'Figure 1')

    def test_does_not_adopt_horizontal_body_paragraph(self):
        figure=block('fig','figure','',.15,.21,.50,.55)
        text=block('text','paragraph','Figure 2 shows this result.',.75,.06,.15,.03)
        a=self.adapter([figure,text]);adopt_sideways_captions(a)
        self.assertEqual(a.blocks,[figure,text]);a._recrop_figure.assert_not_called()

    def test_sideways_shape_requires_tall_narrow_region(self):
        self.assertTrue(sideways_box(dict(width=.03,height=.7)))
        self.assertFalse(sideways_box(dict(width=.7,height=.03)))

if __name__=='__main__': unittest.main()

class FigureCaptionOwnership(unittest.TestCase):
    adapter = FigureRecovery.adapter
    def test_caption_moves_to_picture_on_document_caption_side(self):
        upper=block('upper','figure','',.2,.1,.6,.17)
        lower=block('lower','figure','Figure 11: Accuracy.',.2,.35,.6,.15)
        lower['label']='Figure 11'
        a=self.adapter([upper,lower]);a._figure_caption_below=[True,True,False]
        a._attached_caption_boxes={'lower':dict(page=1,x=.2,y=.31,width=.6,height=.02)}
        a.report.caption_sides_fixed=0;a._page_image=lambda page:None
        a._fix_caption_sides()
        self.assertEqual(upper['label'],'Figure 11');self.assertEqual(lower['text'],'')
        self.assertNotIn('lower',a._attached_caption_boxes)

    def test_panel_band_ignores_small_overlap_from_other_column(self):
        code=block('code','code','(:action hide_character)',.088,.60,.332,.16)
        caption=block('cap','caption','Figure 5: Action example.',.088,.784,.39,.04)
        other=block('prose','paragraph','The other column contains long ordinary prose which must remain separate from this code example.',.49,.70,.35,.07)
        a=self.adapter([code,caption,other])
        bounds,members=a._panel_band(1,caption,'above')
        self.assertEqual(members,[code]);self.assertLess(bounds[2],.50)

    def test_linked_figure_label_is_not_absorbed_into_crop(self):
        label=block('link','paragraph','Project: https://example.org',.2,.2,.3,.02)
        label['evidence']['signals']=['figure-linked-label']
        self.assertFalse(self.adapter([label])._figure_like(label))

class PictureGalleries(unittest.TestCase):
    def gallery(self):
        from figure_recovery import recover_picture_galleries
        owner=block('owner','figure','Figure 8: Examples.',.2,.65,.1,.06)
        description=block('desc','caption','Instructions above the gallery panels.',.2,.23,.6,.02)
        outside=block('body','paragraph','Unrelated prose stays readable.',.2,.85,.6,.05)
        a=FigureRecovery.adapter(self,[owner,description,outside])
        cap=dict(page=1,x=.18,y=.80,width=.64,height=.03)
        a._attached_caption_boxes={'owner':cap}
        pics=[]
        for i in range(6):
            box=dict(page=1,x=.2+(i%3)*.2,y=.3+(i//3)*.25,width=.19,height=.15)
            pic=SimpleNamespace(captions=[],box=box,self_ref='pic'+str(i))
            pics.append(pic)
        desc_item=SimpleNamespace(text=description['text'],box=description['evidence']['boxes'][0])
        pics[0].captions=[SimpleNamespace(resolve=lambda doc:desc_item)]
        a.doc=SimpleNamespace(texts=[SimpleNamespace(text=owner['text'],prov=[SimpleNamespace(page_no=1)])],pictures=pics)
        a._box=lambda item:item.box;a._source_id=lambda item:item.self_ref;a.assets=[]
        a._recrop_figure=lambda figure,*args:figure.update(fallbackAssetIds=['new'])
        a.report.figures=1;a.report.subpanel_figures_merged=0
        return a,owner,description,outside

    def test_dense_gallery_preserves_instruction_region_and_outside_prose(self):
        from figure_recovery import recover_picture_galleries
        a,owner,desc,outside=self.gallery();recover_picture_galleries(a)
        self.assertIn('picture-gallery',owner['evidence']['signals'])
        self.assertNotIn(desc,a.blocks);self.assertIn(outside,a.blocks)
        self.assertIn('desc',owner['evidence']['sourceIds'])
        self.assertTrue(all('pic'+str(i) in owner['evidence']['sourceIds'] for i in range(6)))

    def test_table_within_gallery_region_prevents_absorption(self):
        from figure_recovery import recover_picture_galleries
        a,owner,desc,outside=self.gallery();table=block('table','table','Table data',.2,.4,.4,.1);a.blocks.append(table)
        recover_picture_galleries(a)
        self.assertIn(desc,a.blocks);self.assertNotIn('picture-gallery',owner['evidence']['signals'])

class ReviewRegressions(unittest.TestCase):
    adapter = FigureRecovery.adapter

    def test_inner_partial_caption_does_not_replace_complete_attached_caption(self):
        fig=block('fig','figure','Figure 1: First line. Second line with additional detail.',.2,.2,.6,.3)
        fig['fallbackAssetIds']=['image'];fig['inline']=[dict(start=22,end=33,href='https://example.org')]
        a=self.adapter([fig]);cap=dict(page=1,x=.2,y=.49,width=.6,height=.07)
        a._attached_caption_boxes={'fig':cap}
        a._lines_in=lambda *args:[(.49,.505,'Figure 1: First line.')]
        a.report.captions_read_from_source=0
        original=fig['text'];original_runs=list(fig['inline'])
        a._read_captions_inside_figures()
        self.assertEqual(fig['text'],original);self.assertEqual(fig['inline'],original_runs)
        self.assertEqual(a._attached_caption_boxes['fig'],cap)

    def test_crop_contains_entire_listing_wider_than_caption(self):
        code=block('code','code','Wide listing content',.2,.3,.6,.2)
        caption=block('cap','caption','Figure 3: Listing.',.35,.52,.3,.02)
        a=self.adapter([code,caption]);bounds,members=a._panel_band(1,caption,'above')
        self.assertLessEqual(bounds[0],.2);self.assertGreaterEqual(bounds[2],.8)
        self.assertEqual(members,[code])

    def test_blank_source_band_is_not_a_recovered_figure(self):
        from PIL import Image
        caption=block('cap','caption','Figure 7: Absent artwork.',.2,.5,.6,.03)
        a=self.adapter([caption]);a._page_image=lambda page:Image.new('RGB',(1000,1000),'white')
        a._panel_band=lambda *args:None;a._diagnostic=lambda *args:None
        a._recover_uncaptured_figures()
        self.assertEqual(a.blocks,[caption]);self.assertEqual(caption['kind'],'caption')

    def test_sideways_caption_preserves_shifted_hyperlinks(self):
        figure=block('fig','figure','',.15,.21,.50,.55)
        caption=block('cap','caption','Figure 2: data',.75,.06,.03,.85)
        caption['inline']=[dict(start=10,end=14,href='https://example.org/data')]
        continuation=block('cont','caption','  and code ',.793,.06,.03,.85)
        continuation['inline']=[dict(start=6,end=10,href='https://example.org/code')]
        a=self.adapter([figure,caption,continuation]);adopt_sideways_captions(a)
        self.assertEqual([(figure['text'][r['start']:r['end']],r['href']) for r in figure['inline']],
                         [('data','https://example.org/data'),('code','https://example.org/code')])

class SidewaysCropBounds(unittest.TestCase):
    def test_side_caption_does_not_cut_horizontal_slice_during_panel_union(self):
        figure=block('fig','figure','Figure 2: Plot.',.15,.21,.50,.55)
        figure['fallbackAssetIds']=['old']
        legend=block('legend','caption','Method A B C',.67,.4,.03,.1)
        a=FigureRecovery.adapter(self,[figure,legend]);a.assets=[dict(id='old')]
        a._attached_caption_boxes={'fig':dict(page=1,x=.75,y=.06,width=.03,height=.85)}
        a._crop_asset=lambda *args:'new';a._absorb_block=lambda b:a.blocks.remove(b)
        a.report.figures=1;a.report.subpanel_figures_merged=0;a.report.panels_folded_by_geometry=0
        a._fold_panels_by_geometry()
        self.assertAlmostEqual(figure['evidence']['boxes'][0]['height'],.55)
        self.assertEqual(a.blocks,[figure])

class HeadingCropBoundaries(unittest.TestCase):
    def test_section_number_cannot_bridge_heading_into_following_chart(self):
        figure=block('fig','figure','Figure 9: Chart.',.17678,.48454,.64566,.13182)
        number=block('number','paragraph','6.2',.17647,.4507,.022,.0108)
        heading=block('heading','paragraph','SAMPLE-LEVEL DETECTION OF PROBLEMATIC DATA',.21595,.4507,.35847,.0108)
        a=FigureRecovery.adapter(self,[number,heading,figure]);a.doc=SimpleNamespace(texts=[],pictures=[])
        a.assets=[];a._crop_asset=Mock(return_value='new');a._absorb_block=lambda b:a.blocks.remove(b)
        a.report.panels_folded_by_geometry=0
        a._fold_panels_by_geometry()
        self.assertEqual(a.blocks,[number,heading,figure]);a._crop_asset.assert_not_called()

class CaptionColumnContinuations(unittest.TestCase):
    def test_second_subplot_caption_continues_numbered_caption(self):
        from figure_recovery import join_caption_columns
        owner=block('fig','figure','Figure 1: Mean Absolute Error',.13,.06,.37,.27)
        panel=block('panel','figure','(MAE) across age groups; data.',.51,.06,.36,.27)
        panel['inline']=[dict(start=25,end=29,href='https://example.org')]
        a=FigureRecovery.adapter(self,[owner,panel])
        a._attached_caption_boxes={'fig':dict(page=1,x=.066,y=.34,width=.425,height=.06),'panel':dict(page=1,x=.515,y=.34,width=.425,height=.06)}
        join_caption_columns(a,owner,[owner,panel])
        self.assertEqual(owner['text'],'Figure 1: Mean Absolute Error (MAE) across age groups; data.')
        run=owner['inline'][0];self.assertEqual(owner['text'][run['start']:run['end']],'data')

class FigureLabelNamespaces(unittest.TestCase):
    def test_extended_data_caption_prefix_is_preserved_and_distinct(self):
        from pdf2struct import clean_caption, canonical_figure_label, FIGURE_CAPTION_RE
        text='Extended Data Fig. 2 | Prediction performance.'
        self.assertEqual(clean_caption(text),text)
        self.assertEqual(canonical_figure_label(text),'Extended Data Figure 2')
        self.assertEqual(canonical_figure_label('Fig. 2 | Prediction performance.'),'Figure 2')
        self.assertEqual(FIGURE_CAPTION_RE.match(text).group(2),'2')

    def test_page_number_noise_does_not_delete_extended_data_namespace(self):
        from pdf2struct import clean_caption
        self.assertEqual(clean_caption('16 Extended Data Fig. 1 | Analysis.'),'Extended Data Fig. 1 | Analysis.')

class CaptionDestinationEvidence(unittest.TestCase):
    def test_caption_geometry_retention_keeps_asset_artwork_bounds(self):
        from figure_recovery import retain_caption_evidence
        fig=block('fig','figure','Figure 2: Caption.',.2,.2,.6,.3)
        cap=dict(page=2,x=.2,y=.1,width=.6,height=.04)
        a=FigureRecovery.adapter(self,[fig]);a._attached_caption_boxes={'fig':cap}
        asset=dict(evidence=dict(boxes=[dict(fig['evidence']['boxes'][0])]))
        a.assets=[asset]
        retain_caption_evidence(a);retain_caption_evidence(a)
        self.assertEqual(len(fig['evidence']['boxes']),2)
        self.assertEqual(len(asset['evidence']['boxes']),1)
        self.assertEqual(fig['evidence']['pages'],[1,2])

class HangingCaptionNamespaces(unittest.TestCase):
    def test_inset_crop_cannot_strip_attached_extended_data_namespace(self):
        fig=block('fig','figure','Extended Data Fig. 1 | Complete source caption across columns.',.14,.06,.37,.275)
        fig['fallbackAssetIds']=['image'];fig['label']='Extended Data Figure 1'
        a=FigureRecovery.adapter(self,[fig]);a._attached_caption_boxes={'fig':dict(page=1,x=.066,y=.336,width=.426,height=.06)}
        a._lines_in=lambda *args:[(.336,.344,'Fig. 1 | Complete source caption')]
        a.report.captions_read_from_source=0
        a._read_captions_inside_figures()
        self.assertEqual(fig['label'],'Extended Data Figure 1')
        self.assertEqual(fig['text'],'Extended Data Fig. 1 | Complete source caption across columns.')
        self.assertEqual(a.blocks,[fig])
